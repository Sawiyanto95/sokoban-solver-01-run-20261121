[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Sawiyanto95/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Sawiyanto95/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Solver

A Sokoban solver built for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. It answers a whole set of 5 levels in one run, in as few pushes as it
can.

## How it works

The levels are a hallway with independent rooms off it: a box pushed out of a
room through its door can never be pushed back, so every box stays in its
room. The solver therefore splits each level into rooms and solves every room
on its own, push-optimally, then joins the room solutions with the player's
walks between rooms. The rooms' optima add up to the level's optimum, so a
level solved this way is solved in the fewest pushes possible.

The search in a room is an A* over pushes. A state is the boxes' squares plus
the player's reachable region (named by its lowest square). One push costs 1.
The heuristic is the cheapest assignment of boxes to goals by pull-distance
(the fewest pushes to bring one box onto a goal, the other boxes ignored):
a push moves one box one square, so the assignment cost can fall by at most 1
a push, which makes the heuristic admissible, and the first solved state the
search pops is push-optimal. Two deadlocks are pruned, and neither prunes a
solvable state: a dead square (no pull path from it to any goal) and a frozen
2 x 2 block (four squares of walls and boxes holding a box off its goal).

The solver is deterministic: a fixed direction order everywhere, fixed
tie-breaks, no clock, no randomness. Two runs on the same set answer byte for
byte alike. Its work is bounded by state counts, never by time, so it stays
inside the 60-second wall budget for the whole set.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` for every instance and writes
`/output/<id>/solution.txt` (the player's moves in LURD, an upper letter
marking a push). Locally, point it at a set with:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Files

- `main.ts` — the whole solver; Node 22, no dependencies, no network.
- `LICENSE` — MIT.
