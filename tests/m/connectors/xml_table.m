let
	Source = Xml.Tables(File.Contents("C:\data\shop.xml")),
	#"Table" = Source{[Name="item"]}[Table],
	#"Changed Type" = Table.TransformColumnTypes(#"Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"