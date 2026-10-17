let
	Source = Xml.Tables(Web.Contents("https://example.com/d.xml")),
	#"Table" = Source{[Name="item"]}[Table],
	#"Changed Type" = Table.TransformColumnTypes(#"Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"