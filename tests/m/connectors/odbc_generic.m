let
	Source = Odbc.Query("DSN=warehouse", "SELECT * FROM dbo.Sales")
in
	Source