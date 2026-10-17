let
	Source = Sql.Database("srv", "Shop", [Query="SELECT ""Id"" FROM dbo.T"])
in
	Source