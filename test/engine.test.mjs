// 引擎单元测试（零依赖断言），node test/engine.test.mjs
import { replay, minimumWitnessStable, minimumWitnessJoint } from '../src/engine.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; failures.push(msg); console.error('  ✘ ' + msg); }
}
function section(name) { console.log('\n== ' + name); }

function jointEntry(newSet, term = 1, old) {
  return { term, config: { kind: 'joint', ...(old ? { old } : {}), new: newSet } };
}
const finalEntry = (nodes, term = 1) => ({ term, config: { kind: 'final', nodes } });

// ---------- 普通提交 ----------
section('基本复制与多数提交');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(r.ok === true, '两副本持有即可提交(3 节点多数 2)');
  assert(r.snapshots.length === 3, '应产生 3 个快照');
  assert(r.snapshots[2].commitIndex === 1, '提交下标为 1');
  assert(r.snapshots[2].phase.mode === 'stable', '初始为 stable');
}
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '单副本不能凑够多数');
  assert(r.failure.check.matched.length === 1 && r.failure.check.missing.includes('b'), '定位缺失副本 b');
  assert(r.snapshots.length === 1, '失败前快照保留(仅 1 个)');
  assert(r.snapshots[0].commitIndex === 0, '失败提交不落盘 commitIndex');
}

// ---------- 前驱匹配 / 截断 ----------
section('前驱匹配、追加与截断');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 2 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'predecessor', '空日志前驱下标 1 不匹配');
  assert(/缺失该副本|日志短于/.test(r.failure.message), '消息定位缺失匹配副本');
}
{
  // b: [t1]，收到 prev(1,t2) -> 任期不符
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 2, entries: [{ term: 3 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'predecessor', '前驱任期不符须拒绝');
  assert(r.snapshots.length === 1, '拒绝后保留此前快照');
  assert(r.failure.replicas.find((x) => x.node === 'b').length === 1, '被拒副本日志不变');
}
{
  // 同任期条目幂等跳过
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }, { term: 1 }] },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
    ],
  });
  assert(r.ok, '相同任期连续区间重发幂等');
  assert(r.snapshots[1].detail.skipped === 1 && r.snapshots[1].detail.appended === 0, '跳过 1 追加 0');
}
{
  // 未提交尾部截断合法：b: [t1]，prev=0/t0 发 [t2] -> 截断下标 1
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }, { term: 2 }] },
    ],
  });
  assert(r.ok, '未提交尾部允许截断');
  assert(r.snapshots[1].detail.truncatedFrom === 1 && r.snapshots[1].detail.appended === 2, '自下标 1 截断并追加 2');
  const b = r.snapshots[1].replicas.find((x) => x.node === 'b');
  assert(b.length === 2 && b.tail[0].term === 2, '截断后日志为两项 t2');
}
{
  // 已提交项不得覆盖
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }] },
    ],
  });
  assert(!r.ok && r.failure.category === 'truncate', '覆盖已提交项须判定非法截断');
  assert(r.failure.conflictIndex === 1 && r.failure.commitIndex === 1, '定位冲突下标与提交下标');
  assert(r.snapshots.length === 3, '保留提交后的快照');
  const b = r.failure.replicas.find((x) => x.node === 'b');
  assert(b.length === 1 && b.tail[0].term === 1, '失败事件不修改日志');
}

// ---------- 联合成员变更 ----------
section('joint/final 配置阶段与联合多数');
{
  // 3->4 正确流程：joint 复制到 a,b(旧多数) + a,d(新集合 a,b,c,d 多数需 a,b 或 a,d)
  const events = [
    { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 1 },
    { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 2 },
  ];
  const r = replay({ nodes: ['a', 'b', 'c'], events });
  assert(r.ok, '联合变更完整流程应通过');
  assert(r.snapshots[3].phase.mode === 'joint', '提交 joint 后进入 joint 阶段');
  assert(r.snapshots[7].phase.mode === 'stable', '提交 final 后恢复 stable');
  assert(eq(r.snapshots[7].phase.nodes, ['a', 'b', 'c', 'd']), 'stable 节点集为新集合');
  const jointCommit = r.snapshots[3].detail.checks[0];
  assert(jointCommit.oldMatched.length === 2 && jointCommit.newMatched.length === 3, '联合阶段双侧多数统计正确');
  const finalCommit = r.snapshots[7].detail.checks[0];
  assert(finalCommit.oldMatched.length === 2 && finalCommit.newMatched.length === 3, 'final 也按联合多数计票');
  // 新节点 d 在快照中出现
  assert(r.snapshots[0].replicas.some((x) => x.node === 'd'), 'joint 出现即为新节点建空日志');
}
{
  // 缺旧集合多数：joint 仅在 a,d
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '旧集合不足多数须失败');
  assert(r.failure.check.oldMatched.length === 1, '旧集合仅 1 匹配');
  assert(eq(r.failure.check.oldMissing, ['b', 'c']), '缺失旧集合节点 b,c');
  assert(r.failure.phase.mode === 'stable', '失败时仍为 stable（joint 未生效）');
}
{
  // 旧多数满足、新集合不足：joint 在 a,b 但 d 没有
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '新集合不足多数须失败');
  assert(r.failure.check.newMatched.length === 2, '新集合仅 a,b 匹配（4 节点需 3）');
  assert(eq(r.failure.check.newMissing, ['c', 'd']), '缺失新集合节点 c,d');
}
{
  // final 早于 joint
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', 'stable 阶段提交 final 须判错误阶段');
}
{
  // joint 生效期间普通条目也须联合多数
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [{ term: 1 }] },
      { type: 'commit', index: 2 },
    ],
  });
  assert(!r.ok, 'joint 期间普通条目仍须双侧多数');
  assert(r.failure.category === 'quorum' && r.failure.check.index === 2, '失败定位到下标 2');
  assert(eq(r.failure.check.newMissing, ['c', 'd']), '新集合缺 c,d（4 节点需 3，仅 a,b 匹配）');
}
{
  // final 集合与 joint.new 不一致
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'd', 'e'])] },
      { type: 'commit', index: 2 },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', 'final 集合偏离 joint.new 须判错误阶段');
}
{
  // joint 生效后、final 提交前又开启新 joint -> 复制时即判阶段错误
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [jointEntry(['a', 'b', 'c', 'd', 'e'])] },
    ],
  });
  assert(!r.ok && r.failure.category === 'phase', '联合生效期间不能开启第二次 joint');
}

// ---------- 两次成员变更 ----------
section('两次成员变更（串行完成）');
{
  const J1 = jointEntry(['a', 'b', 'c', 'd']);
  const F1 = finalEntry(['a', 'b', 'c', 'd']);
  const J2 = jointEntry(['a', 'b', 'd', 'e']); // 第二次变更，old 自动取 {a,b,c,d}
  const F2 = finalEntry(['a', 'b', 'd', 'e']);
  const repl = (target, prev, term, entries) =>
    ({ type: 'replicate', target, prevLogIndex: prev, prevLogTerm: term, entries });
  const to = (target, prev, term, entries) => repl(target, prev, term, entries);
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      to('a', 0, 0, [J1]), to('b', 0, 0, [J1]), to('d', 0, 0, [J1]),
      { type: 'commit', index: 1 },
      to('a', 1, 1, [F1]), to('b', 1, 1, [F1]), to('d', 1, 1, [F1]),
      { type: 'commit', index: 2 },
      to('a', 2, 1, [J2]), to('b', 2, 1, [J2]), to('d', 2, 1, [J2]),
      // 第二次变更引入的新节点 e 必须先补齐历史日志，前驱才匹配
      to('e', 0, 0, [J1, F1, J2]),
      { type: 'commit', index: 3 },
      to('a', 3, 1, [F2]), to('b', 3, 1, [F2]), to('d', 3, 1, [F2]), to('e', 3, 1, [F2]),
      { type: 'commit', index: 4 },
    ],
  });
  assert(r.ok, '两次串行联合变更应通过');
  assert(eq(r.snapshots.at(-1).phase.nodes, ['a', 'b', 'd', 'e']), '最终配置为第二次 new 集合');
}

// ---------- 可替换多数见证 ----------
section('可替换多数见证：匹配副本与全部最小组');
{
  // 3->4：joint 提交时 a,b,d 持有；旧 {a,b,c} 需 2，新 {a,b,c,d} 需 3
  const events = [
    { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 1 },
    { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'b', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'replicate', target: 'd', prevLogIndex: 1, prevLogTerm: 1, entries: [finalEntry(['a', 'b', 'c', 'd'])] },
    { type: 'commit', index: 2 },
  ];
  const r = replay({ nodes: ['a', 'b', 'c'], events });
  const wj = r.snapshots[3].detail.checks[0].witness;
  assert(wj.rule === 'joint' && wj.entryKind === 'joint', 'joint 条目见证按双侧规则');
  assert(eq(wj.oldMatched, ['a', 'b']) && eq(wj.newMatched, ['a', 'b', 'd']), '双侧匹配副本只列索引+任期匹配者');
  assert(wj.feasible && wj.minSize === 3, '双侧最小组并集最小为 3');
  assert(wj.groups.length === 1, '该分布下仅 1 个最小见证组');
  assert(eq(wj.groups[0].nodes, ['a', 'b', 'd']), '最小组节点为 a,b,d');
  assert(eq(wj.groups[0].oldCovered, ['a', 'b']) && eq(wj.groups[0].newCovered, ['a', 'b', 'd']),
    '最小组标注旧/新集合覆盖');

  // final 提交：落盘后快照已回到 stable，但见证仍须按提交前双集合（含旧集合）
  const finalSnap = r.snapshots[7];
  const wf = finalSnap.detail.checks[0].witness;
  assert(finalSnap.phase.mode === 'stable', 'final 提交快照为 stable');
  assert(wf.rule === 'joint' && wf.entryKind === 'final', 'final 条目见证仍按提交前双侧规则');
  assert(eq(wf.old, ['a', 'b', 'c']) && wf.oldNeed === 2, 'final 见证不遗漏旧集合侧');
  assert(eq(wf.new, ['a', 'b', 'c', 'd']) && wf.newNeed === 3, 'final 见证含新集合侧');
  assert(wf.groups.length === 1 && eq(wf.groups[0].nodes, ['a', 'b', 'd']), 'final 最小组同按双侧取并集');
}
{
  // 全部 4 个新集合副本都持有 joint：旧侧 2 元组合 × 新侧 3 元组合，最小并集 3，共 4 组稳定排列
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'c', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  const w = r.snapshots[4].detail.checks[0].witness;
  assert(w.minSize === 3 && w.groups.length === 4, '全部持有时枚举全部 4 个三元最小组');
  assert(eq(w.groups[0].nodes, ['a', 'b', 'c']) && eq(w.groups[3].nodes, ['b', 'c', 'd']),
    '最小组按节点稳定顺序排列');
  assert(w.groups.every((g) => g.oldCovered.length >= 2 && g.newCovered.length >= 3),
    '每个最小组均同时覆盖双侧多数');
}
{
  // 缺旧侧：joint 仅在 a,d -> 旧侧无法组成最小组
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'd', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  const w = r.failure.check.witness;
  assert(w.feasible === false && w.groups.length === 0 && w.minSize === null, '无法见证时不给任何组');
  assert(w.missingSides.includes('old'), '明确缺失旧集合侧');
  assert(w.missingSides.includes('new'), '该分布下新侧同样不足（a,d 仅 2/4）');
}
{
  // 缺新侧：joint 在 a,b,c（旧 3 个），新集合需 3 个但 d 缺失 -> 缺新侧
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [jointEntry(['a', 'b', 'c', 'd'])] },
      { type: 'commit', index: 1 },
    ],
  });
  const w = r.failure.check.witness;
  assert(!w.feasible && w.missingSides[0] === 'new', '明确缺失新集合侧');
  assert(eq(w.newMissing, ['c', 'd']), '新侧缺失定位 c,d');
}
{
  // 索引+任期必须都匹配：a 在下表 1 持有 t1，b 持有 t2（高任期确立参考条目为 t2），
  // 提交时 a 虽有同下标条目但任期不同，不得计入匹配
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 2 }] },
      { type: 'commit', index: 1 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum', '任期不符不能凑数');
  const w = r.failure.check.witness;
  assert(w.term === 2 && w.rule === 'stable' && eq(w.matched, ['b']) && w.missing.includes('a'),
    'a 在该下标有条目但任期不同，不计入匹配副本（不凭日志长度猜测）');
}
{
  // stable：3 副本全部持有普通条目 -> 全部 2 元组；仅两副本持有 -> 唯一组
  const all = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'replicate', target: 'c', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 1 },
    ],
  });
  const w = all.snapshots[3].detail.checks[0].witness;
  assert(w.rule === 'stable' && w.minSize === 2 && w.groups.length === 3, 'stable 枚举全部最小多数组');
  assert(eq(w.groups.map((g) => g.nodes.join('+')), ['a+b', 'a+c', 'b+c']), 'stable 组稳定顺序');
}
{
  // 一个提交事件跨多个下标：第二下标失败时，第一下标已成功且见证保留在 failure.checks
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }, { term: 1 }] },
      { type: 'replicate', target: 'b', prevLogIndex: 0, prevLogTerm: 0, entries: [{ term: 1 }] },
      { type: 'commit', index: 2 },
    ],
  });
  assert(!r.ok && r.failure.category === 'quorum' && r.failure.check.index === 2, '失败定位下标 2');
  assert(r.failure.checks.length === 1, '失败事件内此前成功的下标检查保留');
  const w0 = r.failure.checks[0].witness;
  assert(w0.index === 1 && w0.feasible && w0.groups.length === 1, '同事件内已成功提交的下标 1 见证可用');
  assert(r.snapshots.length === 2 && r.snapshots.every((s) => s.type === 'replicate'), '失败提交不落快照');
}
{
  // 纯函数：双侧交叠节点双侧计票，最小组为最小并集且稳定排序
  const w = minimumWitnessJoint({
    index: 5, term: 2, entryKind: null,
    old: ['a', 'b', 'c'], neu: ['a', 'b', 'c', 'd', 'e'],
    oldNeed: 2, newNeed: 3,
    oldMatched: ['a', 'b'], newMatched: ['a', 'b', 'd'],
    oldMissing: ['c'], newMissing: ['c', 'e'],
    universe: ['a', 'b', 'c', 'd', 'e'],
  });
  assert(w.feasible && w.minSize === 3, '交叠时最小并集 3（a,b 双侧计票）');
  assert(w.groups.length === 1 && eq(w.groups[0].nodes, ['a', 'b', 'd']), '唯一最小组');
  assert(eq(w.groups[0].oldCovered, ['a', 'b']) && eq(w.groups[0].newCovered, ['a', 'b', 'd']),
    '组内 a,b 同时覆盖旧侧多数，新侧由 a,b,d 覆盖');
}
{
  // 纯函数：stable 不足时显式标记
  const w = minimumWitnessStable({
    index: 1, term: 1, entryKind: null,
    members: ['a', 'b', 'c', 'd', 'e'], need: 3, matched: ['a'], missing: ['b', 'c', 'd', 'e'],
  });
  assert(!w.feasible && w.minSize === null && w.groups.length === 0, 'stable 无有效见证');
  assert(w.missingSides[0] === 'members', '缺失侧为成员集合');
}

// ---------- 输入约束 ----------
section('录入约束');
{
  const r1 = replay({ nodes: ['a', 'b'], events: [] });
  assert(r1.inputError && /3~5/.test(r1.inputError.message), '节点少于 3 个拒绝');
  const many = ['a', 'b', 'c', 'd', 'e', 'f'];
  const r2 = replay({ nodes: many, events: [] });
  assert(r2.inputError && /3~5/.test(r2.inputError.message), '节点多于 5 个拒绝');
  const r3 = replay({
    nodes: ['a', 'b', 'c'],
    events: Array.from({ length: 49 }, () => ({ type: 'commit', index: 1 })),
  });
  assert(r3.inputError && /48/.test(r3.inputError.message), '事件超过 48 项拒绝');
  const j3 = jointEntry(['a', 'b', 'd']);
  const r4 = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0, entries: [j3] },
      { type: 'replicate', target: 'a', prevLogIndex: 1, prevLogTerm: 1, entries: [j3] },
      { type: 'replicate', target: 'a', prevLogIndex: 2, prevLogTerm: 1, entries: [j3] },
    ],
  });
  assert(r4.inputError && /成员变更/.test(r4.inputError.message), '超过两次成员变更拒绝');
}

// ---------- 快照内容 ----------
section('逐事件快照内容');
{
  const r = replay({
    nodes: ['a', 'b', 'c'],
    events: [
      { type: 'replicate', target: 'a', prevLogIndex: 0, prevLogTerm: 0,
        entries: [{ term: 1 }, { term: 2 }] },
      { type: 'commit', index: 1 },
    ],
  });
  // commit 失败（只有 a 有），取最后成功快照
  const s = r.snapshots[0];
  const a = s.replicas.find((x) => x.node === 'a');
  assert(a.tail.length === 2 && a.tail[1].term === 2, '日志末尾展示尾部条目与索引');
  assert(a.tail[0].index === 1, '尾部条目标注日志下标');
  assert(s.commitIndex === 0, '提交前 commitIndex=0');
  assert(s.replicas.length === 3, '每个副本一行');
}

function eq(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

console.log(`\n${failed === 0 ? '✔' : '✘'} 单测通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
if (failed) console.error(failures.join('\n'));
