let
	Source = Odbc.Query("Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=C:\data\shop.accdb;", "SELECT Id, Name FROM People")
in
	Source