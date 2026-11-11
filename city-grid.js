function lotCoordinates(index) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError("Building index must be a non-negative safe integer.");
  // Square spiral over lot cells so new districts keep extending without a world boundary.
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2);
  let gx = 0;
  let gy = 0;
  if (ring > 0) {
    const side = ring * 2;
    const delta = (2 * ring + 1) ** 2 - 1 - index;
    if (delta < side) {
      gx = ring - delta;
      gy = -ring;
    } else if (delta < side * 2) {
      gx = -ring;
      gy = -ring + delta - side;
    } else if (delta < side * 3) {
      gx = -ring + delta - side * 2;
      gy = ring;
    } else {
      gx = ring;
      gy = ring - (delta - side * 3);
    }
  }
  // Keep lot centers on the legacy grid; roads run halfway between old and new lots.
  const x = gx * 110;
  const y = gy * 90;
  return { x, y };
}

module.exports = { lotCoordinates };
