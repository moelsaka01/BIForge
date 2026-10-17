let
	Source = Access.Database(File.Contents("C:\data\shop.accdb"), [CreateNavigationProperties=true]),
	#"Table" = Source{[Schema="", Item="People"]}[Data]
in
	#"Table"