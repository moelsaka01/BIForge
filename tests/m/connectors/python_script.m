let
	Source = Python.Execute("import pandas as pd#(lf)df = pd.DataFrame({'Id': [1, 2], 'Name': ['a', 'b']})"),
	#"Table" = Source{[Name="df"]}[Value]
in
	#"Table"