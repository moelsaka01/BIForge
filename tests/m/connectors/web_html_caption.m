let
	Source = Web.Page(Web.Contents("https://example.com/p")),
	#"Table" = Source{[Caption="Sales"]}[Data],
	#"Changed Type" = Table.TransformColumnTypes(#"Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"