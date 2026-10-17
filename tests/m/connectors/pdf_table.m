let
	Source = Pdf.Tables(File.Contents("C:\data\report.pdf"), [Implementation="1.3"]),
	#"Table" = Source{[Id="Table002"]}[Data],
	#"Changed Type" = Table.TransformColumnTypes(#"Table", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"