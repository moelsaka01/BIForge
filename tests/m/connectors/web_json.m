let
	Source = Json.Document(Web.Contents("https://example.com/api?x=1")),
	#"Navigation" = Source["rows"],
	#"Converted to Table" = Table.FromRecords(#"Navigation"),
	#"Changed Type" = Table.TransformColumnTypes(#"Converted to Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"