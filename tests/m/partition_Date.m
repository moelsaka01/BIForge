let
	Source = Csv.Document(File.Contents("{{FIXTURES}}/Date.csv"), [Delimiter=",", Columns=8, Encoding=65001, QuoteStyle=QuoteStyle.Csv]),
	#"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
	#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"Date", type date}, {"Year", Int64.Type}, {"Quarter", type text}, {"MonthNumber", Int64.Type}, {"Month", type text}, {"YearMonth", Int64.Type}, {"DayOfWeek", Int64.Type}, {"IsWeekend", type logical}}, "en-US")
in
	#"Changed Type"