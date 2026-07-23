export type WidgetRoute = "index" | "pair";

export function selectWidgetRoute(search: string): WidgetRoute {
  const widgetName = new URLSearchParams(search).get("widgetName");
  return widgetName === "pair" || widgetName === "pair.html" ? "pair" : "index";
}
