let
	Source = Csv.Document(File.Contents("{{FIXTURES}}/Sales.csv"), [Delimiter=",", Columns=10, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
	#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
	#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"SalesKey", Int64.Type}, {"OrderDate", type date}, {"ShipDate", type date}, {"CustomerKey", Int64.Type}, {"ProductKey", Int64.Type}, {"PromotionKey", Int64.Type}, {"Quantity", Int64.Type}, {"UnitPrice", type number}, {"Discount", type number}, {"Channel", type text}}, "en-US")
in
	#"Changed Type"