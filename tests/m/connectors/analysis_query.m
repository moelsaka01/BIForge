let
	Source = AnalysisServices.Database("ssas01", "Cube", [Query="EVALUATE SUMMARIZECOLUMNS(Product[Category], ""n"", [Orders])"])
in
	Source