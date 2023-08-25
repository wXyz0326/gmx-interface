import { JsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { useWeb3React } from "@web3-react/core";
import { isDevelopment } from "config/env";
import { WS_LOST_FOCUS_TIMEOUT } from "config/ui";
import { useChainId } from "lib/chains";
import { closeWsConnection, getWsProvider, isProviderInClosedState, isWebsocketProvider } from "lib/rpc";
import { useHasLostFocus } from "lib/useHasPageLostFocus";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

const WS_HEALTH_CHECK_INTERVAL = 1000 * 10;
const WS_RECONNECT_INTERVAL = 1000 * 5;

export type WebsocketContextType = {
  wsProvider?: WebSocketProvider | JsonRpcProvider;
};

export const WsContext = createContext({} as WebsocketContextType);

export function useWebsocketProvider() {
  return useContext(WsContext) as WebsocketContextType;
}

export function WebsocketContextProvider({ children }: { children: React.ReactNode }) {
  const { active } = useWeb3React();
  const { chainId } = useChainId();
  const [wsProvider, setWsProvider] = useState<WebSocketProvider | JsonRpcProvider>();
  const hasLostFocus = useHasLostFocus({ timeout: WS_LOST_FOCUS_TIMEOUT, checkIsTabFocused: true, debugId: "Tab" });
  const initializedTime = useRef<number>();
  const healthCheckTimerId = useRef<any>();

  useEffect(
    function updateProviderEff() {
      if (!active || hasLostFocus) {
        return;
      }

      const provider = getWsProvider(chainId);
      setWsProvider(provider);

      if (provider) {
        initializedTime.current = Date.now();
        // eslint-disable-next-line no-console
        console.log(`ws provider for chain ${chainId} initialized at ${initializedTime.current}`);
      }

      return function cleanup() {
        initializedTime.current = undefined;
        clearTimeout(healthCheckTimerId.current);

        if (isWebsocketProvider(provider)) {
          setTimeout(() => {
            closeWsConnection(provider);
          });
        }

        // eslint-disable-next-line no-console
        console.log(`ws provider for chain ${chainId} disconnected at ${Date.now()}`);
      };
    },
    [active, chainId, hasLostFocus]
  );

  useEffect(
    function healthCheckEff() {
      if (!active || hasLostFocus || !isWebsocketProvider(wsProvider)) {
        return;
      }

      function nextHealthCheck() {
        if (!isWebsocketProvider(wsProvider)) {
          return;
        }

        if (isDevelopment()) {
          // eslint-disable-next-line no-console
          console.log(
            `ws provider health check, state: ${wsProvider._websocket.readyState}, subs: ${
              Object.keys(wsProvider._subs).length
            }`
          );
        }

        if (
          isProviderInClosedState(wsProvider) &&
          initializedTime.current &&
          Date.now() - initializedTime.current > WS_RECONNECT_INTERVAL
        ) {
          closeWsConnection(wsProvider);
          const provider = getWsProvider(chainId);
          setWsProvider(provider);
          initializedTime.current = Date.now();
          // eslint-disable-next-line no-console
          console.log("ws provider health check failed, reconnecting", initializedTime.current);
        } else {
          healthCheckTimerId.current = setTimeout(nextHealthCheck, WS_HEALTH_CHECK_INTERVAL);
        }
      }

      nextHealthCheck();

      return function cleanup() {
        clearTimeout(healthCheckTimerId.current);
      };
    },
    [active, chainId, hasLostFocus, wsProvider]
  );

  const state: WebsocketContextType = useMemo(() => {
    return {
      wsProvider,
    };
  }, [wsProvider]);

  return <WsContext.Provider value={state}>{children}</WsContext.Provider>;
}
