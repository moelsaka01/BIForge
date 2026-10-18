let
	Source = OleDb.Query("Provider=SQLOLEDB;Data Source=srv;Initial Catalog=Shop", "SELECT Id, Name FROM dbo.People")
in
	Source