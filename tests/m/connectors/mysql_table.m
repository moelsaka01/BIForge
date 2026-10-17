let
	Source = MySQL.Database("db.local:3307", "shop"),
	#"Table" = Source{[Schema="shop", Item="orders"]}[Data]
in
	#"Table"