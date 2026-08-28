/** Short fun facts for the voice showcase menu. */

export const FUN_FACTS: readonly string[] = [
  "Honey never spoils — archaeologists have found edible honey in ancient Egyptian tombs.",
  "Octopuses have three hearts and blue blood.",
  "A day on Venus is longer than a year on Venus.",
  "Bananas are berries, but strawberries are not.",
  "The Eiffel Tower can grow about six inches taller in summer heat.",
  "Sharks existed before trees appeared on Earth.",
] as const;

let factIndex = 0;

/** Pick the next fun fact (rotates through the list). */
export function pickFunFact(): string {
  const fact = FUN_FACTS[factIndex % FUN_FACTS.length]!;
  factIndex += 1;
  return fact;
}

/** Reset rotation (for tests). */
export function resetFunFactIndex(): void {
  factIndex = 0;
}
