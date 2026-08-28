/**
 * Pure conversation state machine for the voice-showcase template.
 * Tests import this module directly — no defineAgent dependency.
 */

import { formatRecipeSpeech, pickRecipe } from "./recipes.js";
import { pickFunFact } from "./fun-facts.js";
import {
  formatWeatherSpeech,
  lookupWeather,
  matchCountryName,
  parseLocationUtterance,
  type FetchFn,
  type WeatherResult,
} from "./weather.js";

export const GREETING =
  "Hi and welcome to the Voicethere voice chat, may I know your name?";

export const HUMAN_ESCALATION_REPLY =
  "This is only a showcase conversation and unfortunately there is no human support connected.";

export const NAME_DECLINE_REPLY = "OK we will continue without your name";

export const MENU_ITEMS = [
  { id: 1, label: "Check the weather" },
  { id: 2, label: "Count" },
  { id: 3, label: "Hear a recipe" },
  { id: 4, label: "Hear a fun fact" },
] as const;

export const MENU_CHAT_TEXT = `Here is our menu:
1. Check the weather
2. Count
3. Hear a recipe
4. Hear a fun fact`;

export type ConversationPhase =
  | "listeningForName"
  | "awaitingMenuChoice"
  | "weatherAwaitingLocation"
  | "countAwaitingNumber"
  | "recipeAwaitingChoice";

export interface ConversationState {
  phase: ConversationPhase;
  name?: string;
  nameDeclined: boolean;
  weatherCity?: string;
  weatherCountry?: string;
  weatherRetries: number;
  countFailures: number;
}

export interface OutboundMessage {
  type: "chat_reply" | "menu" | "agent_event";
  text?: string;
  event?: string;
  items?: Array<{ id: number; label: string }>;
  sessionId?: string;
  raw?: unknown;
}

export interface ConversationTurnResult {
  state: ConversationState;
  speakLines: string[];
  messages: OutboundMessage[];
  pendingWeather?: { city: string; country?: string };
}

export function createInitialState(): ConversationState {
  return {
    phase: "listeningForName",
    nameDeclined: false,
    weatherRetries: 0,
    countFailures: 0,
  };
}

export function buildMenuMessages(): OutboundMessage[] {
  return [
    { type: "chat_reply", text: MENU_CHAT_TEXT },
    {
      type: "menu",
      items: MENU_ITEMS.map((item) => ({ id: item.id, label: item.label })),
    },
  ];
}

function speakAndChat(text: string): {
  speakLines: string[];
  messages: OutboundMessage[];
} {
  return {
    speakLines: [text],
    messages: [{ type: "chat_reply", text }],
  };
}

export function isHumanEscalation(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  const patterns = [
    /\bhuman\b/,
    /\boperator\b/,
    /\breal\s+person\b/,
    /\btalk\s+to\s+(?:a\s+)?(?:human|person|someone|agent)\b/,
    /\bcustomer\s+support\b/,
    /\bspeak\s+to\s+(?:a\s+)?(?:human|person|someone|agent)\b/,
    /\bneed\s+(?:a\s+)?(?:human|person|agent)\b/,
    /\bconnect\s+me\s+(?:to|with)\b/,
    /\blive\s+agent\b/,
    /\brepresentative\b/,
  ];
  return patterns.some((p) => p.test(lower));
}

export function isNameDecline(utterance: string): boolean {
  const lower = utterance.toLowerCase().trim();
  const declinePhrases = [
    "i do not want to say my name",
    "i don't want to say my name",
    "i don't want to say",
    "i do not want to say",
    "i'd rather not",
    "id rather not",
    "prefer not",
    "skip",
    "anonymous",
    "none",
  ];
  if (declinePhrases.some((p) => lower.includes(p))) return true;
  if (/\bno\b/i.test(utterance) && !/\bknow\b/i.test(utterance)) {
    const words = lower.split(/\s+/);
    if (words.includes("no")) return true;
  }
  return false;
}

export function extractName(utterance: string): string | null {
  const trimmed = utterance.trim();
  const patterns = [/(?:my name is|i'm|i am|call me)\s+(.+)/i];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return sanitizeName(match[1]);
    }
  }
  if (trimmed.length > 0 && trimmed.length <= 60) {
    return sanitizeName(trimmed);
  }
  return null;
}

function sanitizeName(raw: string): string {
  let name = raw
    .trim()
    .replace(/[.,!?;:]+$/g, "")
    .trim();
  if (name.length > 40) {
    name = name.slice(0, 40).trim();
  }
  return name;
}

function helloAfterName(state: ConversationState): string {
  if (state.name && !state.nameDeclined) {
    return `Hello, ${state.name}, how can I help you today? I just sent you our menu, what do you want to do?`;
  }
  return "Hello, how can I help you today? I just sent you our menu, what do you want to do?";
}

export function transitionAfterName(
  state: ConversationState,
  name: string | null,
  declined: boolean,
): ConversationTurnResult {
  const next: ConversationState = {
    ...state,
    phase: "awaitingMenuChoice",
    nameDeclined: declined,
    name: declined ? undefined : (name ?? undefined),
  };

  const lines: string[] = [];
  const messages: OutboundMessage[] = [];

  if (declined) {
    const decline = speakAndChat(NAME_DECLINE_REPLY);
    lines.push(...decline.speakLines);
    messages.push(...decline.messages);
  } else if (name) {
    const thanks = speakAndChat(`Great, thank you ${name}`);
    lines.push(...thanks.speakLines);
    messages.push(...thanks.messages);
  }

  const hello = speakAndChat(helloAfterName(next));
  lines.push(...hello.speakLines);
  messages.push(...hello.messages);
  messages.push(...buildMenuMessages());

  return { state: next, speakLines: lines, messages };
}

export type MenuChoice =
  "weather" | "count" | "recipe" | "fun_fact" | "menu" | null;

export function parseMenuChoice(utterance: string): MenuChoice {
  const lower = utterance.toLowerCase().trim();
  if (
    /\bmenu\b/.test(lower) ||
    /\bhelp\b/.test(lower) ||
    /\bgo\s+back\b/.test(lower) ||
    /\bstart\s+over\b/.test(lower)
  ) {
    return "menu";
  }
  if (
    lower === "1" ||
    /\bweather\b/.test(lower) ||
    /\bfirst\b/.test(lower) ||
    /\bcheck\s+the\s+weather\b/.test(lower)
  ) {
    return "weather";
  }
  if (lower === "2" || /\bcount\b/.test(lower) || /\bsecond\b/.test(lower)) {
    return "count";
  }
  if (lower === "3" || /\brecipe\b/.test(lower) || /\bthird\b/.test(lower)) {
    return "recipe";
  }
  if (
    lower === "4" ||
    /\bfun\s+fact\b/.test(lower) ||
    /\bfact\b/.test(lower) ||
    /\bfourth\b/.test(lower)
  ) {
    return "fun_fact";
  }
  return null;
}

const WORD_TO_NUMBER: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function parseCountNumber(utterance: string): number | null {
  const trimmed = utterance.trim().toLowerCase();
  const digit = trimmed.match(/\b(\d+)\b/);
  if (digit) {
    const n = Number(digit[1]);
    if (Number.isFinite(n)) return n;
  }
  for (const [word, value] of Object.entries(WORD_TO_NUMBER)) {
    if (new RegExp(`\\b${word}\\b`).test(trimmed)) {
      return value;
    }
  }
  return null;
}

export function formatCountingSpeech(n: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    parts.push(String(i));
  }
  return parts.join(", ");
}

function resendMenu(state: ConversationState): ConversationTurnResult {
  const menu = speakAndChat("Here is the menu again.");
  return {
    state: { ...state, phase: "awaitingMenuChoice" },
    speakLines: menu.speakLines,
    messages: [...menu.messages, ...buildMenuMessages()],
  };
}

function returnToMenu(
  state: ConversationState,
  line: string,
): ConversationTurnResult {
  const spoken = speakAndChat(line);
  return {
    state: {
      ...state,
      phase: "awaitingMenuChoice",
      weatherRetries: 0,
      countFailures: 0,
      weatherCity: undefined,
      weatherCountry: undefined,
    },
    speakLines: spoken.speakLines,
    messages: [...spoken.messages, ...buildMenuMessages()],
  };
}

export function handleUtterance(
  state: ConversationState,
  utterance: string,
): ConversationTurnResult {
  const text = utterance.trim();
  if (!text) {
    return { state, speakLines: [], messages: [] };
  }

  if (isHumanEscalation(text)) {
    const reply = speakAndChat(HUMAN_ESCALATION_REPLY);
    return {
      state,
      speakLines: reply.speakLines,
      messages: reply.messages,
    };
  }

  if (state.phase !== "listeningForName" && parseMenuChoice(text) === "menu") {
    return resendMenu({
      ...state,
      phase: "awaitingMenuChoice",
      weatherRetries: 0,
      countFailures: 0,
      weatherCity: undefined,
      weatherCountry: undefined,
    });
  }

  switch (state.phase) {
    case "listeningForName": {
      if (isNameDecline(text)) {
        return transitionAfterName(state, null, true);
      }
      const name = extractName(text);
      return transitionAfterName(state, name, false);
    }

    case "awaitingMenuChoice": {
      const choice = parseMenuChoice(text);
      if (choice === "menu") return resendMenu(state);
      if (choice === "weather") {
        const ask = speakAndChat(
          "Sure. Please tell me a city or ZIP code and the country.",
        );
        return {
          state: {
            ...state,
            phase: "weatherAwaitingLocation",
            weatherRetries: 0,
            weatherCity: undefined,
            weatherCountry: undefined,
          },
          speakLines: ask.speakLines,
          messages: ask.messages,
        };
      }
      if (choice === "count") {
        const ask = speakAndChat(
          "Pick a number from 1 to 10 and I will count up to it.",
        );
        return {
          state: {
            ...state,
            phase: "countAwaitingNumber",
            countFailures: 0,
          },
          speakLines: ask.speakLines,
          messages: ask.messages,
        };
      }
      if (choice === "recipe") {
        const ask = speakAndChat(
          "What do you fancy? Try pasta, soup, breakfast, cookies, or salad.",
        );
        return {
          state: { ...state, phase: "recipeAwaitingChoice" },
          speakLines: ask.speakLines,
          messages: ask.messages,
        };
      }
      if (choice === "fun_fact") {
        const fact = pickFunFact();
        return returnToMenu(state, `Here is a fun fact. ${fact}`);
      }
      const retry = speakAndChat(
        "I did not catch that. Pick 1 through 4 from the menu, or say weather, count, recipe, or fun fact.",
      );
      return {
        state,
        speakLines: retry.speakLines,
        messages: retry.messages,
      };
    }

    case "weatherAwaitingLocation": {
      const parsed = parseLocationUtterance(text);
      let city = parsed?.city || state.weatherCity;
      let country = parsed?.country || state.weatherCountry;

      // Country-only follow-up: "Thailand" must not overwrite a stored ZIP as city.
      if (state.weatherCity && !country) {
        const followUp =
          matchCountryName(text) ??
          (parsed?.city ? matchCountryName(parsed.city) : null);
        if (followUp) {
          city = state.weatherCity;
          country = followUp;
        }
      }

      if (!city) {
        const ask = speakAndChat(
          "Please tell me a city or ZIP code and the country.",
        );
        return {
          state: { ...state, phase: "weatherAwaitingLocation" },
          speakLines: ask.speakLines,
          messages: ask.messages,
        };
      }

      if (!country) {
        return {
          state: {
            ...state,
            phase: "weatherAwaitingLocation",
            weatherCity: city,
          },
          speakLines: ["Got it. Which country is that in?"],
          messages: [
            { type: "chat_reply", text: "Got it. Which country is that in?" },
          ],
        };
      }

      return {
        state: { ...state, weatherCity: city, weatherCountry: country },
        speakLines: [],
        messages: [],
        pendingWeather: { city, country },
      };
    }

    case "countAwaitingNumber": {
      const n = parseCountNumber(text);
      if (n === null || n < 1 || n > 10) {
        const failures = state.countFailures + 1;
        if (failures >= 2) {
          return returnToMenu(state, "Sorry, I cannot do this.");
        }
        const retry = speakAndChat(
          "I did not understand you. Please say a number from 1 to 10.",
        );
        return {
          state: { ...state, countFailures: failures },
          speakLines: retry.speakLines,
          messages: retry.messages,
        };
      }
      const counting = formatCountingSpeech(n);
      return returnToMenu(state, `Counting: ${counting}.`);
    }

    case "recipeAwaitingChoice": {
      const recipe = pickRecipe(text);
      const speech = formatRecipeSpeech(recipe);
      return returnToMenu(state, speech);
    }

    default:
      return { state, speakLines: [], messages: [] };
  }
}

export function applyWeatherSuccess(
  state: ConversationState,
  weather: WeatherResult,
): ConversationTurnResult {
  const line = formatWeatherSpeech(weather);
  return returnToMenu(state, line);
}

export function applyWeatherFailure(
  state: ConversationState,
): ConversationTurnResult {
  const retries = state.weatherRetries + 1;
  if (retries >= 2) {
    return returnToMenu(
      { ...state, weatherRetries: retries },
      "Sorry, I could not look up the weather right now.",
    );
  }
  const retry = speakAndChat(
    "I could not find that location. Please try again with a city or ZIP and country.",
  );
  return {
    state: {
      ...state,
      phase: "weatherAwaitingLocation",
      weatherRetries: retries,
      weatherCity: undefined,
      weatherCountry: undefined,
    },
    speakLines: retry.speakLines,
    messages: retry.messages,
  };
}

export async function resolveWeatherTurn(
  state: ConversationState,
  city: string,
  country: string | undefined,
  fetchFn?: FetchFn,
): Promise<ConversationTurnResult> {
  try {
    const weather = await lookupWeather(city, country, fetchFn);
    if (!weather) {
      return applyWeatherFailure(state);
    }
    return applyWeatherSuccess(state, weather);
  } catch {
    return applyWeatherFailure(state);
  }
}
