import assert from "node:assert/strict";
import { test } from "node:test";
import { excludeAprOutliers } from "./optionsAprOutliers";

test("puts compare higher strikes and calls compare lower strikes, including exactly 10x", () => {
  const puts = [{ x: 120, y: 5 }, { x: 110, y: 50 }, { x: 105, y: 49 }];
  assert.deepEqual(excludeAprOutliers(puts, "put", 100), [puts[0], puts[2]]);
  const calls = [{ x: 90, y: 50 }, { x: 95, y: 49 }, { x: 80, y: 5 }];
  assert.deepEqual(excludeAprOutliers(calls, "call", 100), [calls[1], calls[2]]);
});

test("ATM and OTM points remain, and opposite directions and equal strikes do not count", () => {
  const points = [{ x: 90, y: 1000 }, { x: 100, y: 1000 }, { x: 110, y: 1000 }];
  assert.deepEqual(excludeAprOutliers(points, "put", 100), points);
  assert.deepEqual(excludeAprOutliers(points, "call", 100), points);
  assert.deepEqual(excludeAprOutliers([{ x: 110, y: 50 }, { x: 110, y: 1 }], "put", 100),
    [{ x: 110, y: 50 }, { x: 110, y: 1 }]);
  assert.deepEqual(excludeAprOutliers([{ x: 90, y: 100 }, { x: 95, y: 1 }], "put", 100),
    [{ x: 90, y: 100 }, { x: 95, y: 1 }]);
  assert.deepEqual(excludeAprOutliers([{ x: 105, y: 1 }, { x: 110, y: 100 }], "call", 100),
    [{ x: 105, y: 1 }, { x: 110, y: 100 }]);
});

test("any qualifying point counts, using the original series without mutation", () => {
  const points = Object.freeze([
    Object.freeze({ x: 110, y: 100 }),
    Object.freeze({ x: 120, y: 200 }),
    Object.freeze({ x: 130, y: 10 }),
    Object.freeze({ x: 140, y: 1 }),
  ]);
  assert.deepEqual(excludeAprOutliers(points, "put", 100), [points[3]]);
  assert.equal(points.length, 4);
});

test("empty or isolated series stay intact; zero APR does not exclude another zero", () => {
  assert.deepEqual(excludeAprOutliers([], "call", 100), []);
  assert.deepEqual(excludeAprOutliers([{ x: 90, y: 100 }], "call", 100), [{ x: 90, y: 100 }]);
  const points = [{ x: 110, y: 20 }, { x: 120, y: 0 }, { x: 130, y: 0 }];
  assert.deepEqual(excludeAprOutliers(points, "put", 100), points.slice(1));
});
