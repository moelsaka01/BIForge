let
	Source = OleDb.Query("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\data\shop.accdb", "SELECT * FROM Order Details")
in
	Source