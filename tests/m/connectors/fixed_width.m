let
	Source = Lines.FromBinary(File.Contents("C:\data\fw.txt"), null, null, 65001),
	#"Lines" = Table.FromList(Source, Splitter.SplitByNothing(), {"Line"}),
	#"Split" = Table.SplitColumn(#"Lines", "Line", Splitter.SplitTextByPositions({0, 4, 14}), {"Column1", "Column2", "Column3"}),
	#"Trimmed" = Table.TransformColumns(#"Split", {{"Column1", Text.Trim, type text}, {"Column2", Text.Trim, type text}, {"Column3", Text.Trim, type text}}),
	#"Promoted Headers" = Table.PromoteHeaders(#"Trimmed", [PromoteAllScalars=true]),
	#"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers", {{"Id", Int64.Type}, {"Name", type text}}, "en-US")
in
	#"Changed Type"