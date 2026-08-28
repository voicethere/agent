import { describe, expect, it, beforeEach } from "vitest";

import {
  createInitialState,
  formatCountingSpeech,
  GREETING,
  handleUtterance,
  isHumanEscalation,
  isNameDecline,
  parseCountNumber,
  parseMenuChoice,
  resolveWeatherTurn,
  transitionAfterName,
} from "../templates/voice-showcase/conversation.js";
import { resetFunFactIndex } from "../templates/voice-showcase/fun-facts.js";
import {
  geocodeLocation,
  lookupWeather,
  parseLocationUtterance,
  spokenDigitsToPostal,
  wmoCodeToPhrase,
  type FetchFn,
} from "../templates/voice-showcase/weather.js";

describe("voice-showcase conversation", () => {
  beforeEach(() => {
    resetFunFactIndex();
  });

  it("starts in listeningForName with greeting text available", () => {
    const state = createInitialState();
    expect(state.phase).toBe("listeningForName");
    expect(GREETING).toContain("may I know your name");
  });

  it("accepts name from my name is Ada", () => {
    let state = createInitialState();
    const result = handleUtterance(state, "my name is Ada");
    expect(result.state.phase).toBe("awaitingMenuChoice");
    expect(result.state.name).toBe("Ada");
    expect(
      result.speakLines.some((line) => line.includes("Great, thank you Ada")),
    ).toBe(true);
    expect(result.messages.some((m) => m.type === "menu")).toBe(true);
    state = result.state;
  });

  it("declines name when user says no", () => {
    const result = handleUtterance(createInitialState(), "no");
    expect(result.state.nameDeclined).toBe(true);
    expect(result.state.phase).toBe("awaitingMenuChoice");
    expect(result.speakLines).toContain(
      "OK we will continue without your name",
    );
  });

  it("does not treat know as a name decline", () => {
    expect(isNameDecline("I want to know the weather")).toBe(false);
    const result = handleUtterance(createInitialState(), "I want to know");
    expect(result.state.nameDeclined).toBe(false);
  });

  it("human escalation does not change phase", () => {
    const state = createInitialState();
    const result = handleUtterance(state, "I need to talk to a human");
    expect(result.state.phase).toBe("listeningForName");
    expect(result.speakLines[0]).toContain("no human support");
    expect(isHumanEscalation("customer support please")).toBe(true);
  });

  it("routes menu choices", () => {
    let state = transitionAfterName(createInitialState(), "Sam", false).state;
    expect(parseMenuChoice("weather")).toBe("weather");
    expect(parseMenuChoice("2")).toBe("count");
    expect(parseMenuChoice("recipe")).toBe("recipe");
    expect(parseMenuChoice("fun fact")).toBe("fun_fact");

    const weather = handleUtterance(state, "weather");
    expect(weather.state.phase).toBe("weatherAwaitingLocation");
    state = weather.state;

    const count = handleUtterance(state, "menu");
    expect(count.messages.some((m) => m.type === "menu")).toBe(true);
    state = count.state;

    const countAsk = handleUtterance(state, "count");
    expect(countAsk.state.phase).toBe("countAwaitingNumber");
    state = countAsk.state;

    const recipe = handleUtterance(state, "menu");
    state = recipe.state;
    const recipeAsk = handleUtterance(state, "recipe");
    expect(recipeAsk.state.phase).toBe("recipeAwaitingChoice");
    state = recipeAsk.state;

    const fact = handleUtterance(state, "menu");
    state = fact.state;
    const factResult = handleUtterance(state, "fun fact");
    expect(factResult.state.phase).toBe("awaitingMenuChoice");
    expect(factResult.speakLines[0]).toContain("fun fact");
  });

  it("counts to 5 on success", () => {
    let state = transitionAfterName(createInitialState(), null, true).state;
    state = handleUtterance(state, "count").state;
    const result = handleUtterance(state, "five");
    expect(result.state.phase).toBe("awaitingMenuChoice");
    expect(result.speakLines[0]).toContain("1, 2, 3, 4, 5");
    expect(formatCountingSpeech(5)).toBe("1, 2, 3, 4, 5");
  });

  it("count two-strike give up for 11 then garbage", () => {
    let state = transitionAfterName(createInitialState(), null, true).state;
    state = handleUtterance(state, "count").state;

    const first = handleUtterance(state, "eleven");
    expect(first.state.countFailures).toBe(1);
    expect(first.speakLines[0]).toContain("1 to 10");

    const second = handleUtterance(first.state, "garbage");
    expect(second.state.phase).toBe("awaitingMenuChoice");
    expect(second.speakLines[0]).toContain("cannot do this");
    expect(parseCountNumber("11")).toBe(11);
  });

  it("parseLocationUtterance extracts city and country", () => {
    expect(parseLocationUtterance("Paris, France")).toEqual({
      city: "Paris",
      country: "France",
    });
    expect(parseLocationUtterance("Berlin in Germany")).toEqual({
      city: "Berlin",
      country: "Germany",
    });
  });

  it("parseLocationUtterance treats a country name as country, not city", () => {
    expect(parseLocationUtterance("Thailand")).toEqual({
      country: "Thailand",
    });
  });

  it("parseLocationUtterance extracts spoken ZIP plus trailing country", () => {
    expect(
      spokenDigitsToPostal("welcome down there eight four three two zero"),
    ).toBe("84320");
    expect(
      parseLocationUtterance(
        "Welcome down there eight four three two zero Thailand",
      ),
    ).toEqual({
      city: "84320",
      country: "Thailand",
    });
  });

  it("weather country follow-up keeps stored ZIP and looks up", () => {
    let state = transitionAfterName(createInitialState(), "Lee", false).state;
    state = handleUtterance(state, "weather").state;
    const zipOnly = handleUtterance(state, "84320");
    expect(zipOnly.speakLines[0]).toContain("Which country");
    expect(zipOnly.state.weatherCity).toBe("84320");
    expect(zipOnly.pendingWeather).toBeUndefined();

    const country = handleUtterance(zipOnly.state, "Thailand");
    expect(country.pendingWeather).toEqual({
      city: "84320",
      country: "Thailand",
    });
    expect(country.speakLines).toEqual([]);
  });

  it("weather lookup success and failure with mock fetch", async () => {
    const geoResponse = {
      results: [
        {
          name: "Paris",
          country: "France",
          latitude: 48.85,
          longitude: 2.35,
        },
      ],
    };
    const forecastResponse = {
      current: {
        temperature_2m: 18.2,
        weather_code: 0,
        wind_speed_10m: 12,
      },
    };

    const mockFetch: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("geocoding-api")) {
        return {
          ok: true,
          json: async () => geoResponse,
        } as Response;
      }
      if (url.includes("api.open-meteo.com")) {
        return {
          ok: true,
          json: async () => forecastResponse,
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const geo = await geocodeLocation("Paris", "France", mockFetch);
    expect(geo?.name).toBe("Paris");

    const weather = await lookupWeather("Paris", "France", mockFetch);
    expect(weather?.place).toContain("Paris");
    expect(wmoCodeToPhrase(0)).toBe("clear sky");

    let state = transitionAfterName(createInitialState(), "Lee", false).state;
    state = handleUtterance(state, "weather").state;
    const pending = handleUtterance(state, "Paris, France");
    expect(pending.pendingWeather).toEqual({
      city: "Paris",
      country: "France",
    });

    const resolved = await resolveWeatherTurn(
      pending.state,
      "Paris",
      "France",
      mockFetch,
    );
    expect(resolved.state.phase).toBe("awaitingMenuChoice");
    expect(resolved.speakLines[0]).toContain("Paris");

    const failFetch: FetchFn = async () =>
      ({ ok: false, json: async () => ({}) }) as Response;
    const failed = await resolveWeatherTurn(
      pending.state,
      "Nowhere",
      "ZZ",
      failFetch,
    );
    expect(failed.speakLines[0]).toContain("could not find");
  });
});
