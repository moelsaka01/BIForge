let
	Source = AnalysisServices.Database("localhost:51234", "Model", [Query="EVALUATE 'Sales'"])
in
	Source