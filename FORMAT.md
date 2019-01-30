```
struct {
	int32 version = 3;
	double created;
	int32 lifetime;
	int32 nameLength;
	int32 modulesCount;
	int32 scriptSourceLength;
	int32 cachedDataLength;
	int32 resolveCount;
	char name[nameLength];
	char nodeModulesIntegrity[13];
	struct ModuleInfo {
		int32 filenameLength;
		int32 sourceLength;
	} moduleInfo[modulesCount];
	struct ModuleData {
		char filename[moduleInfo[i].filenameLength];
		byte source[moduleInfo[i].sourceLength];
	} moduleData[modulesCount];
	char scriptSource[scriptSourceLength];
	byte cachedData[cachedDataLength];
	struct ResolveInfo {
		int32 keyLength;
		int32 resultLength;
	} resolveInfo[resolveCount];
	struct ResolveData {
		char key[resolveInfo[i].keyLength];
		char result[resolveInfo[i].resultLength];
	} resolveData[resolveCount];
}
```
