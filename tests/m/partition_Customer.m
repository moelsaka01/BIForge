let
	Source = Csv.Document(File.Contents("{{FIXTURES}}/Customer.csv"), [Delimiter=",", Columns=6, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
	#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
	#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"CustomerKey", Int64.Type}, {"Customer", type text}, {"City", type text}, {"Country", type text}, {"Segment", type text}, {"BirthDate", type date}}, "en-US")
in
	#"Changed Type"