let
	Source = OData.Feed("https://svc.example.com/odata", null, [Implementation="2.0"]),
	#"Table" = Source{[Name="Products"]}[Data]
in
	#"Table"