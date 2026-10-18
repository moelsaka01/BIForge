let
	Source = Json.Document(Web.Contents("https://api.example.com/v1/items", [Headers=[#"X-Api-Version"="2"]])),
	#"Navigation" = Source["rows"],
	#"Converted to Table" = Table.FromRecords(#"Navigation"),
	#"Changed Type" = Table.TransformColumnTypes(#"Converted to Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"