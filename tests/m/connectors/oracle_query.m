let
	Source = Oracle.Database("ora:1521/orcl", [Query="SELECT * FROM HR.EMP"])
in
	Source