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
): { city: string; country?: string } | null {
  const text = utterance.trim();
  if (!text) return null;

  const inMatch = text.match(
    /^(?:in\s+)?(.+?)\s+in\s+([a-zA-Z][\w\s.-]{1,40})$/i,
  );
  if (inMatch) {
    return { city: inMatch[1]!.trim(), country: inMatch[2]!.trim() };
  }

  const commaMatch = text.match(/^(.+?),\s*([a-zA-Z][\w\s.-]{1,40})$/);
  if (commaMatch) {
    return { city: commaMatch[1]!.trim(), country: commaMatch[2]!.trim() };
  }

  const countryMatch = text.match(
    /^(.+?)\s+(?:country\s+)?([a-zA-Z][\w\s.-]{2,40})$/i,
  );
  if (countryMatch && countryMatch[2]!.split(/\s+/).length <= 3) {
    const city = countryMatch[1]!.trim();
    const country = countryMatch[2]!.trim();
    if (city.length >= 2 && country.length >= 2) {
      return { city, country };
    }
  }

  if (/^\d{5}(-\d{4})?$/.test(text)) {
    return { city: text };
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
