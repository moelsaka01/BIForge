let
	Source = R.Execute("df <- data.frame(Id = 1:2, Name = c(""a"", ""b""))"),
	#"Table" = Source{0}[Value]
in
	#"Table"