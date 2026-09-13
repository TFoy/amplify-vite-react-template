type AprPoint = { x: number; y: number };

// Compare against the original series so filtering one point cannot affect another.
export function excludeAprOutliers<T extends AprPoint>(
  points: readonly T[],
  optionType: "call" | "put",
  underlyingPrice: number,
): T[] {
  const isOutOfTheMoney = (point: T) => optionType === "put"
    ? point.x < underlyingPrice
    : point.x > underlyingPrice;
  return points.filter((point) => {
    if (!isOutOfTheMoney(point) || !Number.isFinite(point.y) || point.y <= 0) {
      return true;
    }
    return !points.some((other) =>
      isOutOfTheMoney(other) &&
      (optionType === "put" ? other.x > point.x : other.x < point.x) &&
      Number.isFinite(other.y) && other.y >= 0 &&
      point.y >= 10 * other.y,
    );
  });
}
