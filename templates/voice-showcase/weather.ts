/** Open-Meteo geocoding + current weather (no API key). */

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const FETCH_TIMEOUT_MS = 8000;

export interface GeocodeResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface WeatherResult {
  place: string;
  temperatureC: number;
  condition: string;
  windKmh: number;
}

export type FetchFn = typeof fetch;

export type ParsedLocation = {
  city?: string;
  country?: string;
};

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** Lowercase aliases → Open-Meteo-friendly country names. */
const COUNTRY_ALIASES: Record<string, string> = {
  thailand: "Thailand",
  us: "United States",
  usa: "United States",
  america: "United States",
  "united states": "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  britain: "United Kingdom",
  england: "United Kingdom",
  "united kingdom": "United Kingdom",
  "great britain": "United Kingdom",
  germany: "Germany",
  france: "France",
  spain: "Spain",
  italy: "Italy",
  japan: "Japan",
  china: "China",
  india: "India",
  australia: "Australia",
  canada: "Canada",
  brazil: "Brazil",
  mexico: "Mexico",
  netherlands: "Netherlands",
  holland: "Netherlands",
  "the netherlands": "Netherlands",
  belgium: "Belgium",
  switzerland: "Switzerland",
  sweden: "Sweden",
  norway: "Norway",
  denmark: "Denmark",
  finland: "Finland",
  poland: "Poland",
  portugal: "Portugal",
  greece: "Greece",
  turkey: "Turkey",
  egypt: "Egypt",
  "south africa": "South Africa",
  "new zealand": "New Zealand",
  ireland: "Ireland",
  singapore: "Singapore",
  malaysia: "Malaysia",
  indonesia: "Indonesia",
  vietnam: "Vietnam",
  philippines: "Philippines",
  "south korea": "South Korea",
  korea: "South Korea",
  taiwan: "Taiwan",
  "hong kong": "Hong Kong",
  israel: "Israel",
  uae: "United Arab Emirates",
  "united arab emirates": "United Arab Emirates",
  "saudi arabia": "Saudi Arabia",
  pakistan: "Pakistan",
  bangladesh: "Bangladesh",
  nigeria: "Nigeria",
  kenya: "Kenya",
  argentina: "Argentina",
  chile: "Chile",
  colombia: "Colombia",
  peru: "Peru",
  austria: "Austria",
  "czech republic": "Czechia",
  czechia: "Czechia",
  romania: "Romania",
  hungary: "Hungary",
  ukraine: "Ukraine",
};

export function matchCountryName(text: string): string | null {
  const key = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+/g, " ");
  if (!key) return null;
  return COUNTRY_ALIASES[key] ?? null;
}

/** "eight four three two zero" → "84320" (4–6 digits). */
export function spokenDigitsToPostal(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const digits: string[] = [];
  for (const token of tokens) {
    if (/^\d$/.test(token)) {
      digits.push(token);
      continue;
    }
    const mapped = DIGIT_WORDS[token];
    if (mapped) {
      digits.push(mapped);
    }
    // Skip STT filler ("welcome", "down", "there", …).
  }
  if (digits.length >= 4 && digits.length <= 6) {
    return digits.join("");
  }
  return null;
}

function splitTrailingCountry(
  text: string,
): { rest: string; country: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  for (let n = Math.min(3, words.length - 1); n >= 1; n -= 1) {
    const tail = words.slice(-n).join(" ");
    const country = matchCountryName(tail);
    if (country) {
      return { rest: words.slice(0, -n).join(" "), country };
    }
  }
  return null;
}

function cityFromRemainder(rest: string): string | null {
  const trimmed = rest
    .trim()
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+(?:in the|in|of)$/i, "")
    .trim();
  if (!trimmed) return null;
  if (/^\d{4,6}(-\d{4})?$/.test(trimmed)) {
    return trimmed;
  }
  const spoken = spokenDigitsToPostal(trimmed);
  if (spoken) return spoken;
  if (trimmed.length >= 2 && trimmed.length <= 60) {
    return trimmed;
  }
  return null;
}

/** Map WMO weather_code to a short English phrase. */
export function wmoCodeToPhrase(code: number): string {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code <= 99) return "thunderstorm";
  return "variable conditions";
}

export function formatWeatherSpeech(result: WeatherResult): string {
  const temp = Math.round(result.temperatureC);
  const wind = Math.round(result.windKmh);
  return `In ${result.place}, it is ${temp} degrees Celsius with ${result.condition} and winds around ${wind} kilometers per hour.`;
}

/** Parse city/zip and country from a single utterance when possible. */
export function parseLocationUtterance(
  utterance: string,
): ParsedLocation | null {
  const text = utterance.trim();
  if (!text) return null;

  const countryOnly = matchCountryName(text);
  if (countryOnly) {
    return { country: countryOnly };
  }

  const trailing = splitTrailingCountry(text);
  if (trailing) {
    const city = cityFromRemainder(trailing.rest);
    if (city) {
      return { city, country: trailing.country };
    }
    return { country: trailing.country };
  }

  const inMatch = text.match(
    /^(?:in\s+)?(.+?)\s+in\s+([a-zA-Z][\w\s.-]{1,40})$/i,
  );
  if (inMatch) {
    const country = matchCountryName(inMatch[2]!) ?? inMatch[2]!.trim();
    return { city: inMatch[1]!.trim(), country };
  }

  const commaMatch = text.match(/^(.+?),\s*([a-zA-Z][\w\s.-]{1,40})$/);
  if (commaMatch) {
    const country = matchCountryName(commaMatch[2]!) ?? commaMatch[2]!.trim();
    return { city: commaMatch[1]!.trim(), country };
  }

  const countryMatch = text.match(
    /^(.+?)\s+(?:country\s+)?([a-zA-Z][\w\s.-]{2,40})$/i,
  );
  if (countryMatch && countryMatch[2]!.split(/\s+/).length <= 3) {
    const city = countryMatch[1]!.trim();
    const countryRaw = countryMatch[2]!.trim();
    const country = matchCountryName(countryRaw) ?? countryRaw;
    if (city.length >= 2 && country.length >= 2) {
      return { city, country };
    }
  }

  if (/^\d{4,6}(-\d{4})?$/.test(text)) {
    return { city: text };
  }

  const spokenPostal = spokenDigitsToPostal(text);
  if (spokenPostal) {
    return { city: spokenPostal };
  }

  if (text.length >= 2 && text.length <= 60) {
    return { city: text };
  }

  return null;
}

export async function geocodeLocation(
  city: string,
  country: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<GeocodeResult | null> {
  const query = country ? `${city}, ${country}` : city;
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetchFn(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    results?: Array<{
      name?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
    }>;
  };

  const hit = data.results?.[0];
  if (
    !hit ||
    typeof hit.latitude !== "number" ||
    typeof hit.longitude !== "number"
  ) {
    return null;
  }

  return {
    name: hit.name ?? city,
    country: hit.country ?? country ?? "",
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
}

export async function fetchCurrentWeather(
  geo: GeocodeResult,
  fetchFn: FetchFn = fetch,
): Promise<WeatherResult | null> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(geo.latitude));
  url.searchParams.set("longitude", String(geo.longitude));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
  url.searchParams.set("wind_speed_unit", "kmh");

  const response = await fetchFn(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    current?: {
      temperature_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
  };

  const current = data.current;
  if (
    !current ||
    typeof current.temperature_2m !== "number" ||
    typeof current.weather_code !== "number"
  ) {
    return null;
  }

  const place = geo.country ? `${geo.name}, ${geo.country}` : geo.name;

  return {
    place,
    temperatureC: current.temperature_2m,
    condition: wmoCodeToPhrase(current.weather_code),
    windKmh: current.wind_speed_10m ?? 0,
  };
}

export async function lookupWeather(
  city: string,
  country: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<WeatherResult | null> {
  const geo = await geocodeLocation(city, country, fetchFn);
  if (!geo) return null;
  return fetchCurrentWeather(geo, fetchFn);
}
