let
	Source = Teradata.Database("td"),
	#"Table" = Source{[Schema="dbc", Item="Tables"]}[Data]
in
	#"Table"