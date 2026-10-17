let
	Source = Odbc.Query("Driver={HDBODBC};ServerNode=hana:30015;", "SELECT * FROM SYSTEM.T")
in
	Source