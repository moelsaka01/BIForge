let
	Source = Json.Document(File.Contents("C:/data/nested.json")),
	#"Converted to Table" = Table.FromRecords(Source),
	#"Expanded addr" = Table.ExpandRecordColumn(#"Converted to Table", "addr", {"city", "geo"}, {"addr.city", "addr.geo"}),
	#"Expanded addr.geo" = Table.ExpandRecordColumn(#"Expanded addr", "addr.geo", {"lat"}, {"addr.geo.lat"}),
	#"Changed Type" = Table.TransformColumnTypes(#"Expanded addr.geo", {{"id", Int64.Type}, {"addr.city", type text}, {"addr.geo.lat", type text}, {"tags", type text}}, "en-US")
in
	#"Changed Type"