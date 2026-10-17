let
	Source = Web.Page(Web.Contents("https://example.com/p")),
	#"Table" = Source{[Id="Table 2"]}[Data],
	#"Changed Type" = Table.TransformColumnTypes(#"Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"