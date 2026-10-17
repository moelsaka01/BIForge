let
	Source = Oracle.Database("ora:1521/orcl"),
	#"Table" = Source{[Schema="HR", Item="EMP"]}[Data]
in
	#"Table"