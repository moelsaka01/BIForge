let
	Source = Csv.Document(Web.Contents("https://example.com/d.csv"), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
	#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
	#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"