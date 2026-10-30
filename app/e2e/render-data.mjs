// Data changes of the render audit: the sample data must exercise the property under test.
const eachProjection = (json, fn) => { for (const w of Object.values(json.visual?.query?.queryState ?? {})) for (const p of w.projections ?? []) fn(p, w); };

/** A measure with decimals (average unit price) instead of the integer quantity, so that precision and rounding show. */
export function decimals(json) {
  eachProjection(json, (p) => {
    const a = p.field?.Aggregation;
    if (a?.Expression?.Column?.Property === "Quantity") {
      a.Expression.Column.Property = "UnitPrice";
      a.Function = 1;
      p.queryRef = "Average(Sales.UnitPrice)";
      p.nativeQueryRef = "Average of UnitPrice";
    }
  });
}

/** One series only, so that every bar segment is large enough to hold its label. */
export function singleSeries(json) {
  const qs = json.visual?.query?.queryState;
  if (qs?.Series) delete qs.Series;
}

const STACKED = /^(columnChart|barChart|hundredPercentStacked\w+|stackedAreaChart)$/;

/** Display units in millions, so that the ticks of an axis and the labels carry decimals the precision can cut. */
export function millions(json, c) {
  const units = c.prop.replace(/[pP]recision$/, "DisplayUnits");
  for (const e of json.visual?.objects?.[c.object] ?? []) e.properties[units] = { expr: { Literal: { Value: "1000000L" } } };
}

const colorLit = (hex) => ({ solid: { color: { expr: { Literal: { Value: `'${hex}'` } } } } });
// the cards that every visual has (title, background, border, ...) are kept in visualContainerObjects, the others in objects
const CONTAINER = new Set(["title", "subTitle", "divider", "spacing", "background", "padding", "border", "dropShadow", "visualHeader", "visualHeaderTooltip", "visualTooltip", "visualLink", "lockAspect", "stylePreset"]);
function setProps(json, object, props) {
  const bag = json.visual.visualContainerObjects && object in json.visual.visualContainerObjects ? json.visual.visualContainerObjects : CONTAINER.has(object) ? (json.visual.visualContainerObjects ??= {}) : (json.visual.objects ??= {});
  const list = (bag[object] ??= [{ properties: {} }]);
  Object.assign(list[0].properties, props);
}

const numLit = (v) => ({ expr: { Literal: { Value: `${v}D` } } });

/** Swaps the quantity (or the average price) of the visual for a measure of the sample model: Variance (negatives), Sparse (blanks), Empty. */
export function measure(json, name) {
  eachProjection(json, (p) => {
    const a = p.field?.Aggregation;
    if (a?.Expression?.Column?.Property === "Quantity") {
      p.field = { Measure: { Expression: { SourceRef: { Entity: "Sales" } }, Property: name } };
      p.queryRef = `Sales.${name}`;
      p.nativeQueryRef = name;
    }
  });
}

/** The category axis shows the months (twelve of them), so that a zoom range or a label rotation has something to cut. */
export function months(json) {
  const cat = json.visual?.query?.queryState?.Category?.projections?.[0];
  if (cat?.field?.Column) { cat.field.Column.Expression.SourceRef.Entity = "Date"; cat.field.Column.Property = "Month"; cat.queryRef = "Date.Month"; cat.nativeQueryRef = "Month"; }
}

const TRUE = { expr: { Literal: { Value: "true" } } };
const LONG = Array.from({ length: 5 }, () => "A long title that needs more room than the visual is wide, so it wraps").join(" and ");

/** A second column level (the year), so that column subtotals have groups to add up. */
export function twoColumnLevels(json) {
  const cols = json.visual?.query?.queryState?.Columns;
  if (cols && cols.projections.length === 1) cols.projections.push({ field: { Column: { Expression: { SourceRef: { Entity: "Date" } }, Property: "Year" } }, queryRef: "Date.Year", nativeQueryRef: "Year" });
}

/** A KPI is in the bad state when the goal is far above the indicator, in the neutral state when they are equal. */
export function kpiState(json, state) {
  const qs = json.visual?.query?.queryState;
  const goal = qs?.Goal?.projections?.[0];
  const ind = qs?.Indicator?.projections?.[0];
  if (!goal || !ind) return;
  if (state === "neutral") delete qs.Goal; // without a goal there is nothing to be good or bad against
  else if (state === "good") return; // the sample indicator is above its goal
  else { goal.field = { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Entity: "Product" } }, Property: "ListPrice" } }, Function: 0 } }; goal.queryRef = "Sum(Product.ListPrice)"; goal.nativeQueryRef = "Sum of ListPrice"; }
}

/** A second column series (the order count), so that columns have a neighbour to overlap. */
export function secondColumn(json) {
  const y = json.visual?.query?.queryState?.Y;
  if (y && y.projections.length === 1) y.projections.push({ field: { Measure: { Expression: { SourceRef: { Entity: "Sales" } }, Property: "Orders" } }, queryRef: "Sales.Orders", nativeQueryRef: "Orders" });
}

export function dataFor(json, c) {
  // panel headers that are wider than the header: the subcategory names (long words), in a large font
  if (c.object === "subheader" && c.prop === "titleWrap") {
    const rows = json.visual?.query?.queryState?.Rows?.projections?.[0];
    if (rows?.field?.Column) { rows.field.Column.Expression.SourceRef.Entity = "Product"; rows.field.Column.Property = "Subcategory"; rows.queryRef = "Product.Subcategory"; rows.nativeQueryRef = "Subcategory"; }
  }
  // an outside label is cut only where it does not fit: long names in a large font
  if (/^(pie|donut)Chart$/.test(c.visualType) && c.object === "labels" && c.prop === "overflow") {
    const cat = json.visual?.query?.queryState?.Category?.projections?.[0];
    if (cat?.field?.Column) { cat.field.Column.Expression.SourceRef.Entity = "Product"; cat.field.Column.Property = "Product"; cat.queryRef = "Product.Product"; cat.nativeQueryRef = "Product"; }
    setProps(json, "labels", { show: TRUE, fontSize: numLit(20) });
  }
  // the text of a shape is turned only where there is a text
  if (c.visualType === "shape" && c.object === "rotation") setProps(json, "text", { show: TRUE, text: { expr: { Literal: { Value: "'Rotated text'" } } } });
  // Q&A shows its states only for a saved question: understood, not understood (error), understood with an assumption (warning)
  if (c.visualType === "qnaVisual" && c.object !== "suggestions" && c.prop !== "savedUtterance") setProps(json, "hiddenProperties", { savedUtterance: { expr: { Literal: { Value: "'" + (c.prop === "errorColor" ? "zz qq xx" : c.prop === "warningColor" ? "quantity by category" : "total quantity by category") + "'" } } } });
  // a number format shows on numbers: the slicers list a numeric column
  if (/^(slicer|advancedSlicerVisual|listSlicer)$/.test(c.visualType) && c.object === "general" && c.prop === "formatString") {
    for (const p of json.visual?.query?.queryState?.Values?.projections ?? []) { p.field = { Column: { Expression: { SourceRef: { Entity: "Sales" } }, Property: "Quantity" } }; p.queryRef = "Sales.Quantity"; p.nativeQueryRef = "Quantity"; }
    // a number field would open as a range slider
    setProps(json, "data", { mode: { expr: { Literal: { Value: c.visualType === "listSlicer" ? "'Dropdown'" : c.visualType === "advancedSlicerVisual" ? "'HorizontalList'" : "'Basic'" } } } });
  }
  // the outcome of the key influencers analysis is one of the values of the target
  // (only the variant has the property: the visual without it takes the first value, Online)
  if (c.visualType === "keyDriversVisual" && c.prop === "targetValue" && json.visual?.objects?.keyDrivers) setProps(json, "keyDrivers", { targetValue: { expr: { Literal: { Value: "'Store'" } } } });
  // the sort order of the influencers shows when there are several fields to explain by
  if (c.visualType === "keyDriversVisual" && c.prop === "selectedSort") {
    const ex = json.visual.query.queryState.ExplainBy.projections;
    for (const [ent, prop] of [["Product", "Subcategory"], ["Customer", "Country"]]) ex.push({ field: { Column: { Expression: { SourceRef: { Entity: ent } }, Property: prop } }, queryRef: ent + "." + prop, nativeQueryRef: prop });
  }
  if (/ComboChart$/.test(c.visualType) && c.object === "layout" && /^clusteredGap/.test(c.prop)) secondColumn(json);
  // two column measures side by side: their large labels meet
  if (/ComboChart$/.test(c.visualType) && c.object === "labels" && c.prop === "optimizeLabelDisplay") secondColumn(json);
  // a disc shows its padding only in a color that differs from the page
  if (c.object === "centerBackground" && c.prop === "padding") setProps(json, "centerBackground", { fillColor: colorLit("#ffcc00") });
  // a 100 % axis ends at 100: the constant line stands at 50
  if (/^hundredPercent/.test(c.visualType) && c.object === "y1AxisReferenceLine" && c.prop !== "value" && c.prop !== "autoScale") for (const e of json.visual?.objects?.y1AxisReferenceLine ?? []) if (e.selector?.id === "constant") e.properties.value = numLit(50);
  // spaces are kept only where the text has runs of them: a value format with a long literal, a caption with several spaces
  if (c.visualType === "card" && c.prop === "preserveWhitespace") {
    if (c.object === "labels") setProps(json, "labels", { valueCustomFormatString: { expr: { Literal: { Value: "'0\"        units\"'" } } } });
    else { const pr = json.visual?.query?.queryState?.Values?.projections?.[0]; if (pr) pr.displayName = "Total          quantity"; }
  }
  // the corners of a tile show only where the tile has a fill (a transparent tile on the page has no visible edge)
  if (c.object === "shapeCustomRectangle" && /^(cardVisual|advancedSlicerVisual|listSlicer)$/.test(c.visualType)) setProps(json, "fillCustom", { show: TRUE, fillColor: colorLit("#ffcc00") });
  // a gauge takes the target of the Axis card only where no field gives one
  if (c.visualType === "gauge" && c.object === "axis" && c.prop === "target") delete json.visual?.query?.queryState?.TargetValue;
  if (c.visualType === "kpi" && c.object === "status") kpiState(json, c.prop === "neutralColor" ? "neutral" : c.prop === "goodColor" ? "good" : "bad");
  if (c.visualType === "cardVisual" && c.object === "accentBar" && c.prop !== "show") setProps(json, "accentBar", { show: TRUE });
  // the corners of an image show their own radii only where each corner has one; the uniform radius is the other way
  if (c.visualType === "image" && c.object === "image" && c.prop === "cornerRadiusAdvanced") setProps(json, "image", { cornerRadius: numLit(0), cornerRadiusLeftTop: numLit(40), cornerRadiusRightBottom: numLit(40) });
  if (c.object === "subTotals" && /^columnSubtotals/.test(c.prop)) twoColumnLevels(json);
  // the label of a row subtotal shows on the subtotal row, which is under the group
  if (c.object === "subTotals" && c.prop === "rowSubtotalsLabel") setProps(json, "subTotals", { rowSubtotalsPosition: { expr: { Literal: { Value: "'Bottom'" } } } });
  if (/^category(Min|Max|Size)$/.test(c.prop) && c.object === "zoom") months(json);
  // a background shows its transparency only where it has a color of its own
  if (/^backgroundTransparency$/.test(c.prop) && /^(labels|totals|categoryLabels)$/.test(c.object)) setProps(json, c.object, { enableBackground: TRUE, backgroundColor: colorLit("#ffcc00") });
  // the background of a category label shows its color once it is on (the switch needs a color of its own to be seen)
  if (c.object === "categoryLabels" && c.prop === "enableBackground") setProps(json, c.object, { backgroundColor: colorLit("#ffcc00") });
  // a title wraps only where it is longer than the visual is wide
  if (c.prop === "titleWrap" && /^(title|subTitle)$/.test(c.object)) setProps(json, c.object, { show: TRUE, text: { expr: { Literal: { Value: "'" + LONG + "'" } } } });
  // text wraps only where it is wider than its column: narrow columns
  if (c.prop === "wordWrap" && /^(tableEx|pivotTable)$/.test(c.visualType) && /^(values|columnHeaders)$/.test(c.object)) setProps(json, "columnHeaders", { customColumnWidth: { expr: { Literal: { Value: "true" } } }, defaultColumnWidth: numLit(50) });
  // a line behind or in front of the data shows only where it crosses a bar: a constant that lies inside the bars
  if (c.object === "y1AxisReferenceLine" && c.prop === "position") for (const e of json.visual?.objects?.y1AxisReferenceLine ?? []) if (e.selector?.id === "constant") e.properties.value = numLit(60);
  if (c.prop === "showPositiveAndNegative" || c.prop === "decreaseFill") measure(json, "Variance");
  // a blank value: the pairs of category and series with a small quantity have none; a card has nothing at all
  if (c.prop === "showBlankAs") measure(json, c.visualType === "cardVisual" || (c.visualType === "donutChart" && c.object === "value") ? "Empty" : "Sparse");
  // a donut with a blank total has no slices at all: the one measure without a category
  if (c.visualType === "donutChart" && c.object === "value" && c.prop === "showBlankAs") delete json.visual?.query?.queryState?.Category;
  // overlapping labels: large ones, so that neighbouring labels collide
  // overlapping labels: large ones that are allowed to overflow their bars (otherwise the ones that do not fit are hidden before any overlap), so that neighbouring labels collide
  if (c.prop === "optimizeLabelDisplay") setProps(json, "labels", { show: { expr: { Literal: { Value: "true" } } }, fontSize: numLit(40), labelOverflow: { expr: { Literal: { Value: "true" } } } });
  // the format string of the visual is used by the labels
  if (c.object === "general" && c.prop === "formatString") setProps(json, "labels", { show: TRUE, labelStyle: { expr: { Literal: { Value: "'Data'" } } } });
  // text wraps where it is wider than its box
  if (/^(label|value)$/.test(c.object) && c.prop === "textWrap" && c.visualType === "donutChart") setProps(json, c.object, { fontSize: numLit(72) });
  // a label that wraps needs a narrow box
  if (c.object === "labels" && c.prop === "wordWrap") setProps(json, "labels", { labelContainerMaxWidth: numLit(10) });
  // a header wraps only where its text is wider than the header: a large font does that for any month name
  if (c.object === "subheader" && c.prop === "titleWrap") setProps(json, "subheader", { fontSize: numLit(40) });
  // the legend marker takes the line's color only where that differs from the series color
  if (c.prop === "matchLineColor") setProps(json, "lineStyles", { strokeColor: colorLit("#112233") });
  if (/recision$/.test(c.prop)) { decimals(json); millions(json, c); }
  if (STACKED.test(c.visualType) && /^(labels|totals)$/.test(c.object) && c.prop !== "showSeries" && c.prop !== "showBlankAs" && c.prop !== "optimizeLabelDisplay" && c.prop !== "labelOverflow") singleSeries(json);
  if (STACKED.test(c.visualType) && c.object === "labels") shortLabels(json, c);
}

/** A long label style ("Data value, percent of total") does not fit inside a stacked segment and is hidden there, as in Desktop: the short style is used. */
export function shortLabels(json, c) {
  if (c.prop === "labelStyle") return;
  for (const e of json.visual?.objects?.labels ?? []) delete e.properties?.labelStyle;
}
