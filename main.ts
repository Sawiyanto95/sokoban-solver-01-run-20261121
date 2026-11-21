// A Sokoban solver for make.fun's "Build the best Sokoban solver" bounty.
//
// How it works
// ------------
// The levels are a hallway with independent rooms off it (see the kit's
// RULES.txt): a box pushed out of a room through its door can never be pushed
// back, so every box stays in its room and the rooms are independent problems,
// joined only by the player's walk between them. This program therefore splits
// each level into rooms and solves every room on its own, push-optimally, then
// joins the room solutions with the walks between rooms. The rooms' optima add
// up to the level's optimum, so a level solved this way is solved in the
// fewest pushes possible.
//
// The search in a room is an A* over pushes. A state is the boxes' squares
// plus the player's reachable region (named by its lowest square: the player's
// exact square inside a region changes nothing about the future pushes). One
// push costs 1. The heuristic is the cheapest assignment of boxes to goals by
// pull-distance (the fewest pushes to bring one box onto a goal, other boxes
// ignored): a push moves one box one square, so the assignment cost can fall
// by at most 1 a push, which makes the heuristic admissible, and the first
// solved state the search pops is push-optimal. Two deadlocks are pruned, and
// neither prunes a solvable state: a dead square (no pull path from it to any
// goal) and a frozen 2 x 2 block (four squares of walls and boxes holding a
// box off its goal).
//
// Determinism: a fixed direction order everywhere, fixed tie-breaks in the
// heap, no clock, no randomness, no environment reads except the input and
// output directories. The work is bounded by state counts, never by time, so
// two runs on the same set answer byte for byte alike.
//
// Limits: one wall budget of 60 seconds covers the whole set of 5 instances.
// The search caps below keep the work far inside it on the levels this
// competition draws (small rooms of 3-4 boxes); a room the search gives up on
// leaves its instance unanswered rather than risking the run's budget.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The most states one room search may generate before it gives up, and the
// most states the whole run may generate across all rooms and instances.
const ROOM_STATE_CAP = 200_000;
const RUN_STATE_BUDGET = 1_000_000;

// Directions, in a fixed order used for every tie-break: up, down, left, right.
type Dir = { dx: number; dy: number; letter: string; push: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, letter: 'u', push: 'U' },
  { dx: 0, dy: 1, letter: 'd', push: 'D' },
  { dx: -1, dy: 0, letter: 'l', push: 'L' },
  { dx: 1, dy: 0, letter: 'r', push: 'R' },
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 is a wall; the outer frame is always wall
  goals: number[]; // sorted
  boxes: number[]; // sorted
  player: number;
};

type Room = {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // Nothing leaves the board: the outer frame is wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Pull distances: dist[g][s] is the fewest pushes to bring one box from
 * square s onto goal g, the other boxes ignored. Found by a reverse search
 * from g: a box on square y can be pulled onto x (one square toward g) when
 * the player can stand on the square behind it, y - d, so y joins the search
 * when y and y - d are open floor. A square no goal's search reaches is dead:
 * a box there can never reach a goal.
 */
function pullDistances(level: Level): { dist: Int32Array[]; live: Uint8Array } {
  const { w, wall, goals } = level;
  const size = wall.length;
  const dist: Int32Array[] = [];
  const live = new Uint8Array(size);
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (let k = 0; k < 4; k++) {
        const dd = DIRS[k].dy * w + DIRS[k].dx;
        const y = x - dd;
        const behind = y - dd;
        if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
        if (wall[y] || wall[behind] || d[y] >= 0) continue;
        d[y] = d[x] + 1;
        queue.push(y);
      }
    }
    dist.push(d);
    for (let i = 0; i < size; i++) if (d[i] >= 0) live[i] = 1;
  }
  return { dist, live };
}

/**
 * The squares the player reaches from `from` around walls and the boxes in
 * `occupied`, marking each reached square in `seen` with `stamp` (a stamp
 * array, so no clearing pass is needed). Returns the lowest square reached.
 * The starting square counts as reached even if it is marked wall: the
 * player may be standing on a square another room's boxes turned into one.
 */
function flood(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
  w: number,
): number {
  const size = wall.length;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // Up, down, left, right, in that order.
    const qs = [p - w, p + w, p - 1, p + 1];
    for (let k = 0; k < 4; k++) {
      const q = qs[k];
      if (q < 0 || q >= size) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2 x 2 block: four
 * squares of walls and boxes, one of them a box off its goal. No push can
 * ever move a box out of such a block, so the state is dead.
 */
function frozenBlock(
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
  w: number,
): boolean {
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (
      (occupied[a] && !goal[a]) ||
      (occupied[b] && !goal[b]) ||
      (occupied[c] && !goal[c]) ||
      (occupied[d] && !goal[d])
    ) {
      return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower-case LURD letters, first direction first on ties. */
function walkTo(
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
  w: number,
): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k].dy * w + DIRS[k].dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k].letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after playing `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The cheapest assignment of boxes to goals by pull-distance: the least, over
 * every one-to-one matching, of the summed pull-distances. Each push moves one
 * box one square, so the assignment cost can fall by at most 1 a push, and it
 * is 0 exactly when every box is on a goal: an admissible heuristic, and one
 * that stays informative when the boxes crowd each other. Infinity when no
 * matching covers every box: the state is dead.
 */
function assignmentHeuristic(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  const used = new Array<boolean>(n).fill(false);
  let best = Infinity;
  const place = (i: number, cost: number): void => {
    if (cost >= best) return;
    if (i === n) {
      best = cost;
      return;
    }
    for (let g = 0; g < n; g++) {
      if (used[g]) continue;
      const d = dist[g][boxes[i]];
      if (d < 0) continue;
      used[g] = true;
      place(i + 1, cost + d);
      used[g] = false;
    }
  };
  place(0, 0);
  return best;
}

/** The weaker sum heuristic: each box's pull-distance to its nearest goal, summed. Used when there are too many boxes to match. */
function sumHeuristic(boxes: number[], dist: Int32Array[]): number {
  let total = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const d of dist) {
      const v = d[b];
      if (v >= 0 && v < m) m = v;
    }
    if (m === Infinity) return Infinity;
    total += m;
  }
  return total;
}

type SearchResult = { pushes: number; moves: string };
type Budget = { used: number; limit: number };

/**
 * The push-optimal solution of `level`: {pushes, moves} (moves in LURD, a
 * lower letter a step, an upper one a push), or null when the search gives up
 * (its state cap, or the run's work budget) or the level has no solution.
 *
 * A* (`mode: 'astar'`) orders states by pushes made plus the assignment
 * heuristic; with the heuristic admissible and consistent, the first solved
 * state popped is push-optimal. `mode: 'bfs'` is the same search with a zero
 * heuristic: plain breadth-first over pushes, the fallback when A* gives up.
 * The states are kept in arrays and named by index; a state's key is its
 * boxes plus its region's lowest square, so two ways of reaching the same
 * boxes with the same reachable region keep only the cheaper.
 */
function searchPushes(
  level: Level,
  maxStates: number,
  mode: 'astar' | 'bfs',
  budget: Budget,
): SearchResult | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const { dist, live } = pullDistances(level);
  if (startBoxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const hCache = new Map<string, number>();
  const heuristic = (bs: number[]): number => {
    const key = bs.join(',');
    const cached = hCache.get(key);
    if (cached !== undefined) return cached;
    const h = mode === 'bfs' || bs.length > 5 ? sumHeuristic(bs, dist) : assignmentHeuristic(bs, dist);
    hCache.set(key, h);
    return h;
  };

  const keyOf = (bs: number[], low: number): string => `${low}:${bs.join(',')}`;

  // The states, in the order found: boxes, the player's square after the push
  // that made the state, the parent state and that push, the pushes made, and
  // the state's key.
  const boxesList: number[][] = [startBoxes.slice()];
  const playerList: number[] = [startPlayer];
  const parentList: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const gList: number[] = [0];
  const keyList: string[] = [];

  for (const b of startBoxes) occupied[b] = 1;
  const startLow = flood(wall, occupied, startPlayer, mark, ++stamp, stack, w);
  for (const b of startBoxes) occupied[b] = 0;
  const startKey = keyOf(startBoxes, startLow);
  keyList.push(startKey);
  const best = new Map<string, number>([[startKey, 0]]);

  // The open list: a binary heap on [f, h, sequence, state], the sequence
  // breaking every tie in insertion order, so the order is fully determined.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  let seq = 0;
  heapPush([h0, h0, seq++, 0]);
  let generated = 1;

  while (heap.length > 0) {
    const [, , , idx] = heapPop();
    if (best.get(keyList[idx]) !== gList[idx]) continue; // superseded by a cheaper way to the same state
    const boxes = boxesList[idx];
    if (solved(boxes)) {
      // Rebuild the moves: walk to each push's square, then push.
      const chain: number[] = [];
      for (let s = idx; s > 0; s = parentList[s]) chain.push(s);
      chain.reverse();
      let moves = '';
      let player = startPlayer;
      let cur = startBoxes.slice();
      const occ = new Uint8Array(size);
      for (const s of chain) {
        const from = pushFrom[s];
        const to = pushTo[s];
        const di = pushDir[s];
        const d = DIRS[di].dy * w + DIRS[di].dx;
        for (const b of cur) occ[b] = 1;
        moves += walkTo(wall, occ, player, from - d, w);
        for (const b of cur) occ[b] = 0;
        moves += DIRS[di].push;
        player = from;
        const at = cur.indexOf(from);
        cur[at] = to;
        cur.sort((a, b) => a - b);
      }
      return { pushes: gList[idx], moves };
    }
    const g = gList[idx];
    const player = playerList[idx];
    for (const b of boxes) occupied[b] = 1;
    flood(wall, occupied, player, seen, ++stamp, stack, w);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di].dy * w + DIRS[di].dx;
        const from = b - d; // the square the player must stand on to push
        const t = b + d; // where the box goes
        if (from < 0 || from >= size || t < 0 || t >= size) continue;
        if (seen[from] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(wall, occupied, goal, t, w)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        const low = flood(wall, occupied, b, mark, ++stamp, stack, w);
        occupied[t] = 0;
        occupied[b] = 1;
        const key = keyOf(next, low);
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        const nh = heuristic(next);
        if (nh === Infinity) continue;
        if (generated >= maxStates || budget.used >= budget.limit) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        generated++;
        budget.used++;
        best.set(key, ng);
        const ni = boxesList.length;
        boxesList.push(next);
        playerList.push(b);
        parentList.push(idx);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(di);
        gList.push(ng);
        keyList.push(key);
        heapPush([ng + nh, nh, seq++, ni]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, with its squares, boxes and goals. Null when the
 * level is no set of rooms: a box starts in the hallway, a goal lies in the
 * hallway, or some part holds more or fewer boxes than goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pullDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DIRS[k].dy * w + DIRS[k].dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    const p = part[b];
    if (p < 0) return null;
    rooms[p].boxes.push(b);
  }
  for (const g of goals) {
    const p = part[g];
    if (p < 0) return null;
    rooms[p].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's. Falls
 * back to solving the whole level at once when it is no set of rooms, and to
 * plain breadth-first search when A* gives up on a room.
 */
function solveByRooms(level: Level, budget: Budget): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    return searchPushes(level, ROOM_STATE_CAP, 'astar', budget);
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const src = other.done ? other.goals : other.boxes;
      for (const b of src) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    let solved = searchPushes(sub, ROOM_STATE_CAP, 'astar', budget);
    if (solved === null) solved = searchPushes(sub, ROOM_STATE_CAP, 'bfs', budget);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves that solve one level, or '' when the level is left unanswered. */
function solveLevel(text: string, budget: Budget): string {
  const solved = solveByRooms(parseLevel(text), budget);
  return solved === null ? '' : solved.moves;
}

// Answer every instance of the set in one run: /input/<id>/level.txt in,
// /output/<id>/solution.txt out. The output directory is only ever created,
// never removed: the grader mounts it, and removing it fails the run.
const budget: Budget = { used: 0, limit: RUN_STATE_BUDGET };
for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
