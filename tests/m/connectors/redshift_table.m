let
	Source = AmazonRedshift.Database("rs:5439", "dev"),
	#"Table" = Source{[Schema="public", Item="sales"]}[Data]
in
	#"Table"