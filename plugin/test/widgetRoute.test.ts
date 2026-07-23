import { describe, expect, it } from "vitest";
import { selectWidgetRoute } from "../src/widgetRoute.js";

describe("widget routing", () => {
  it("renders the index plugin for the main widget", () => {
    expect(selectWidgetRoute("")).toBe("index");
    expect(selectWidgetRoute("?widgetName=index")).toBe("index");
  });

  it("renders the pairing form for popup widget URLs", () => {
    expect(selectWidgetRoute("?widgetName=pair")).toBe("pair");
    expect(selectWidgetRoute("?widgetName=pair.html")).toBe("pair");
  });
});
