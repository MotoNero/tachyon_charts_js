// Moving labels apart so that they do not overlap, for the labels of a pie and the plates of the last values.

/** @internal Places labels from the top down with at least one line between them, within the bounds. */
export function spreadLabels(places: number[], top: number, bottom: number, line: number): void {
  for (let i = 0; i < places.length; i++) {
    places[i] = Math.max(places[i] as number, i === 0 ? top : (places[i - 1] as number) + line);
  }
  for (let i = places.length - 1; i >= 0; i--) {
    places[i] = Math.min(places[i] as number, i === places.length - 1 ? bottom : (places[i + 1] as number) - line);
  }
}
