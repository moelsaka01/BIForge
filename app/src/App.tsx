import { Text } from "@fluentui/react-components";
import { APP_NAME, STATUS_NOTICE } from "./core/info";

export function App() {
  return (
    <main style={{ padding: 24 }}>
      <Text as="h1" size={800} weight="semibold" block>
        {APP_NAME}
      </Text>
      <Text block>{STATUS_NOTICE}</Text>
    </main>
  );
}
