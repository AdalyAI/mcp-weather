import { format } from "node:util";
import axios from "axios";
import { handler as hourlyHandler } from "../src/tools/WeatherTool";
import { handler as dailyHandler } from "../src/tools/WeatherDailyTool";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const extra = {} as RequestHandlerExtra<any, any>;
const tools = [
  ["weather-get_hourly", hourlyHandler],
  ["weather-get_daily", dailyHandler],
] as const;

beforeEach(() => {
  process.env.ACCUWEATHER_API_KEY = "secret-accuweather-key";
  mockedAxios.get.mockReset();
});

afterAll(() => {
  delete process.env.ACCUWEATHER_API_KEY;
});

describe.each(tools)("%s validation failures", (_name, handler) => {
  it.each([
    ["missing location", {}],
    ["empty location", { location: "" }],
    ["non-string location", { location: 42 }],
    ["unknown units", { location: "Paris", units: "kelvin" }],
  ])("returns isError for %s without calling AccuWeather", async (_case, args) => {
    const result = await handler(args, extra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid input: /);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

describe("weather-get_daily days validation", () => {
  it.each([0, 16, 2.5, "five"])("returns isError for days=%p", async (days) => {
    const result = await dailyHandler({ location: "Paris", days }, extra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid input: days/);
  });
});

describe.each(tools)("%s upstream failures", (_name, handler) => {
  it("returns isError when the API key is not configured", async () => {
    delete process.env.ACCUWEATHER_API_KEY;

    const result = await handler({ location: "Paris" }, extra);

    expect(result.isError).toBe(true);
  });

  it("returns isError when the location is unknown", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });

    const result = await handler({ location: "Nowhere" }, extra);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("No location found for: Nowhere");
  });

  it("returns isError and never logs the API key when AccuWeather fails", async () => {
    const realAxios = jest.requireActual("axios");
    const error = new realAxios.AxiosError(
      "Request failed with status code 503",
      "ERR_BAD_RESPONSE",
      { url: "https://dataservice.accuweather.com/locations/v1/cities/search?apikey=secret-accuweather-key&q=Paris" },
      {},
      { status: 503, data: {}, statusText: "", headers: {}, config: {} }
    );
    mockedAxios.get.mockRejectedValueOnce(error);
    mockedAxios.isAxiosError.mockImplementation(realAxios.isAxiosError);
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await handler({ location: "Paris" }, extra);

      expect(result.isError).toBe(true);
      const logOutput = logged.mock.calls.map((call) => format(...call)).join("\n");
      expect(logOutput).toContain("HTTP 503");
      expect(logOutput).not.toContain("secret-accuweather-key");
      expect(JSON.stringify(result)).not.toContain("secret-accuweather-key");
    } finally {
      logged.mockRestore();
    }
  });
});
