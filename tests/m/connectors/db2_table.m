let
	Source = DB2.Database("db2host:50000", "SAMPLE"),
	#"Table" = Source{[Schema="APP", Item="ORDERS"]}[Data]
in
	#"Table"