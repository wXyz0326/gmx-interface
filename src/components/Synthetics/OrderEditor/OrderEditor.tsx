import { Trans, t } from "@lingui/macro";
import BuyInputSection from "components/BuyInputSection/BuyInputSection";
import Modal from "components/Modal/Modal";
import { MarketsInfoData } from "domain/synthetics/markets";
import {
  OrderInfo,
  OrderType,
  PositionOrderInfo,
  SwapOrderInfo,
  isDecreaseOrderType,
  isIncreaseOrderType,
  isLimitOrderType,
  isSwapOrderType,
  isTriggerDecreaseOrderType,
} from "domain/synthetics/orders";
import {
  PositionsInfoData,
  formatLeverage,
  formatAcceptablePrice,
  formatLiquidationPrice,
  getPositionKey,
  getTriggerNameByOrderType,
} from "domain/synthetics/positions";
import {
  TokensData,
  TokensRatio,
  convertToTokenAmount,
  getAmountByRatio,
  getTokenData,
  getTokensRatioByPrice,
} from "domain/synthetics/tokens";
import { useChainId } from "lib/chains";
import { USD_DECIMALS } from "lib/legacy";
import { formatAmount, formatAmountFree, formatTokenAmount, formatUsd, getBasisPoints, parseValue } from "lib/numbers";
import { useEffect, useMemo, useState } from "react";

import ExchangeInfoRow from "components/Exchange/ExchangeInfoRow";
import { ValueTransition } from "components/ValueTransition/ValueTransition";
import { getWrappedToken } from "config/tokens";
import { usePositionsConstants } from "domain/synthetics/positions";
import { BASIS_POINTS_DIVISOR, MAX_ALLOWED_LEVERAGE } from "config/factors";
import {
  estimateExecuteDecreaseOrderGasLimit,
  estimateExecuteIncreaseOrderGasLimit,
  estimateExecuteSwapOrderGasLimit,
  getExecutionFee,
  useGasLimits,
  useGasPrice,
} from "domain/synthetics/fees";
import { updateOrderTxn } from "domain/synthetics/orders/updateOrderTxn";
import { applySlippageToPrice, getSwapPathOutputAddresses, useSwapRoutes } from "domain/synthetics/trade";
import { BigNumber } from "ethers";
import { getByKey } from "lib/objects";
import { getIncreasePositionAmounts, getNextPositionValuesForIncreaseTrade } from "domain/synthetics/trade";
import useUiFeeFactor from "domain/synthetics/fees/utils/useUiFeeFactor";
import { useLocalStorageSerializeKey } from "lib/localStorage";
import { IS_PNL_IN_LEVERAGE_KEY } from "config/localStorage";
import { useUserReferralInfo } from "domain/referrals/hooks";

import Button from "components/Button/Button";
import useWallet from "lib/wallets/useWallet";
import { useSubaccount } from "context/SubaccountContext/SubaccountContext";
import "./OrderEditor.scss";

type Props = {
  positionsData?: PositionsInfoData;
  marketsInfoData?: MarketsInfoData;
  tokensData?: TokensData;
  order: OrderInfo;
  onClose: () => void;
  setPendingTxns: (txns: any) => void;
};

export function OrderEditor(p: Props) {
  const { marketsInfoData, tokensData } = p;
  const { chainId } = useChainId();
  const { signer, account } = useWallet();

  const { gasPrice } = useGasPrice(chainId);
  const { gasLimits } = useGasLimits(chainId);

  const [isInited, setIsInited] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [sizeInputValue, setSizeInputValue] = useState("");
  const sizeDeltaUsd = parseValue(sizeInputValue || "0", USD_DECIMALS);

  const [triggerPirceInputValue, setTriggerPriceInputValue] = useState("");
  const triggerPrice = parseValue(triggerPirceInputValue || "0", USD_DECIMALS)!;

  const uiFeeFactor = useUiFeeFactor(chainId);
  const { minCollateralUsd } = usePositionsConstants(chainId);
  const userReferralInfo = useUserReferralInfo(signer, chainId, account);

  const [savedIsPnlInLeverage] = useLocalStorageSerializeKey([chainId, IS_PNL_IN_LEVERAGE_KEY], false);

  const acceptablePrice = useMemo(() => {
    if (isSwapOrderType(p.order.orderType)) {
      return BigNumber.from(0);
    }

    const positionOrder = p.order as PositionOrderInfo;

    // For SL orders Acceptable Price is not applicable and set to 0 or MaxUnit256
    if (p.order.orderType === OrderType.StopLossDecrease) {
      return positionOrder.acceptablePrice;
    }

    const oldAcceptablePrice = positionOrder.acceptablePrice;
    const oldTriggerPrice = positionOrder.triggerPrice;
    const priceDelta = oldAcceptablePrice?.sub(oldTriggerPrice || 0).abs() || 0;
    const acceptablePriceImpactBps = getBasisPoints(priceDelta, oldTriggerPrice);
    return applySlippageToPrice(
      acceptablePriceImpactBps.toNumber(),
      triggerPrice || oldTriggerPrice,
      p.order.isLong,
      isIncreaseOrderType(p.order.orderType)
    );
  }, [p.order, triggerPrice]);

  // Swaps
  const fromToken = getTokenData(tokensData, p.order.initialCollateralTokenAddress);

  const swapPathInfo = marketsInfoData
    ? getSwapPathOutputAddresses({
        marketsInfoData: marketsInfoData,
        initialCollateralAddress: p.order.initialCollateralTokenAddress,
        swapPath: p.order.swapPath,
        wrappedNativeTokenAddress: getWrappedToken(chainId).address,
        shouldUnwrapNativeToken: p.order.shouldUnwrapNativeToken,
      })
    : undefined;

  const toTokenAddress = swapPathInfo?.outTokenAddress;

  const toToken = getTokenData(tokensData, toTokenAddress);
  const fromTokenPrice = fromToken?.prices?.maxPrice;
  const toTokenPrice = toToken?.prices?.minPrice;
  const [triggerRatioInputValue, setTriggerRatioInputValue] = useState<string>("");

  const markRatio =
    fromToken &&
    toToken &&
    fromTokenPrice &&
    toTokenPrice &&
    getTokensRatioByPrice({
      fromToken,
      toToken,
      fromPrice: fromTokenPrice,
      toPrice: toTokenPrice,
    });

  const isRatioInverted = markRatio?.largestToken.address === fromToken?.address;

  const triggerRatio = useMemo(() => {
    if (!markRatio || !isSwapOrderType(p.order.orderType)) return undefined;

    const ratio = parseValue(triggerRatioInputValue, USD_DECIMALS);

    return {
      ratio: ratio?.gt(0) ? ratio : markRatio.ratio,
      largestToken: markRatio.largestToken,
      smallestToken: markRatio.smallestToken,
    } as TokensRatio;
  }, [markRatio, p.order.orderType, triggerRatioInputValue]);

  let minOutputAmount = p.order.minOutputAmount;

  if (fromToken && toToken && triggerRatio) {
    minOutputAmount = getAmountByRatio({
      fromToken,
      toToken,
      fromTokenAmount: p.order.initialCollateralDeltaAmount,
      ratio: triggerRatio?.ratio,
      shouldInvertRatio: !isRatioInverted,
    });

    const priceImpactAmount = convertToTokenAmount(
      p.order.swapPathStats?.totalSwapPriceImpactDeltaUsd,
      p.order.targetCollateralToken.decimals,
      p.order.targetCollateralToken.prices.minPrice
    );

    const swapFeeAmount = convertToTokenAmount(
      p.order.swapPathStats?.totalSwapFeeUsd,
      p.order.targetCollateralToken.decimals,
      p.order.targetCollateralToken.prices.minPrice
    );

    minOutputAmount = minOutputAmount.add(priceImpactAmount || 0).sub(swapFeeAmount || 0);
  }

  const market = getByKey(marketsInfoData, p.order.marketAddress);
  const indexToken = getTokenData(tokensData, market?.indexTokenAddress);
  const indexPriceDecimals = indexToken?.priceDecimals;
  const markPrice = p.order.isLong ? indexToken?.prices?.minPrice : indexToken?.prices?.maxPrice;

  const positionKey = getPositionKey(
    p.order.account,
    p.order.marketAddress,
    p.order.targetCollateralToken.address,
    p.order.isLong
  );

  const existingPosition = getByKey(p.positionsData, positionKey);

  const executionFee = useMemo(() => {
    if (!p.order.isFrozen || !gasLimits || !gasPrice || !tokensData) return undefined;

    let estimatedGas: BigNumber | undefined;

    if (isSwapOrderType(p.order.orderType)) {
      estimatedGas = estimateExecuteSwapOrderGasLimit(gasLimits, {
        swapsCount: p.order.swapPath.length,
      });
    }

    if (isIncreaseOrderType(p.order.orderType)) {
      estimatedGas = estimateExecuteIncreaseOrderGasLimit(gasLimits, {
        swapsCount: p.order.swapPath.length,
      });
    }

    if (isDecreaseOrderType(p.order.orderType)) {
      estimatedGas = estimateExecuteDecreaseOrderGasLimit(gasLimits, {
        swapsCount: p.order.swapPath.length,
      });
    }

    if (!estimatedGas) return undefined;

    return getExecutionFee(chainId, gasLimits, tokensData, estimatedGas, gasPrice);
  }, [chainId, gasLimits, gasPrice, p.order.isFrozen, p.order.orderType, p.order.swapPath, tokensData]);

  const subaccount = useSubaccount(executionFee?.feeTokenAmount ?? null);
  const swapRoute = useSwapRoutes({
    marketsInfoData,
    fromTokenAddress: p.order.initialCollateralTokenAddress,
    toTokenAddress: existingPosition ? existingPosition.collateralTokenAddress : toTokenAddress,
  });

  const isLimitIncreaseOrder = p.order.orderType === OrderType.LimitIncrease;

  const increaseAmounts = useMemo(() => {
    if (!isLimitIncreaseOrder || !toToken || !fromToken || !market || !triggerPrice?.gt(0)) {
      return undefined;
    }

    const positionOrder = p.order as PositionOrderInfo;

    const indexTokenAmount = convertToTokenAmount(sizeDeltaUsd, positionOrder.indexToken.decimals, triggerPrice);

    return getIncreasePositionAmounts({
      marketInfo: market,
      indexToken: positionOrder.indexToken,
      initialCollateralToken: fromToken,
      collateralToken: p.order.targetCollateralToken,
      isLong: p.order.isLong,
      initialCollateralAmount: p.order.initialCollateralDeltaAmount,
      indexTokenAmount,
      leverage: existingPosition?.leverage,
      triggerPrice: isLimitOrderType(p.order.orderType) ? triggerPrice : undefined,
      position: existingPosition,
      findSwapPath: swapRoute.findSwapPath,
      userReferralInfo,
      uiFeeFactor,
      strategy: "independent",
    });
  }, [
    isLimitIncreaseOrder,
    existingPosition,
    fromToken,
    market,
    sizeDeltaUsd,
    p.order,
    swapRoute,
    toToken,
    triggerPrice,
    uiFeeFactor,
    userReferralInfo,
  ]);

  const nextPositionValues = useMemo(() => {
    if (!isLimitIncreaseOrder || !minCollateralUsd || !market) {
      return undefined;
    }

    if (increaseAmounts?.acceptablePrice && sizeDeltaUsd?.gt(0)) {
      return getNextPositionValuesForIncreaseTrade({
        marketInfo: market,
        collateralToken: p.order.targetCollateralToken,
        existingPosition,
        isLong: p.order.isLong,
        collateralDeltaUsd: increaseAmounts.collateralDeltaUsd,
        collateralDeltaAmount: increaseAmounts.collateralDeltaAmount,
        sizeDeltaUsd: increaseAmounts?.sizeDeltaUsd,
        sizeDeltaInTokens: increaseAmounts.sizeDeltaInTokens,
        indexPrice: increaseAmounts.indexPrice,
        showPnlInLeverage: savedIsPnlInLeverage ?? false,
        minCollateralUsd: minCollateralUsd!,
        userReferralInfo,
      });
    }
  }, [
    increaseAmounts,
    isLimitIncreaseOrder,
    market,
    minCollateralUsd,
    p.order,
    savedIsPnlInLeverage,
    sizeDeltaUsd,
    existingPosition,
    userReferralInfo,
  ]);

  function getError() {
    if (isSubmitting) {
      return t`Updating Order...`;
    }

    if (isSwapOrderType(p.order.orderType)) {
      if (!triggerRatio?.ratio?.gt(0) || !minOutputAmount.gt(0)) {
        return t`Enter a ratio`;
      }

      if (minOutputAmount.eq(p.order.minOutputAmount)) {
        return t`Enter a new ratio`;
      }

      if (triggerRatio && !isRatioInverted && markRatio?.ratio.lt(triggerRatio.ratio)) {
        return t`Price above Mark Price`;
      }

      if (triggerRatio && isRatioInverted && markRatio?.ratio.gt(triggerRatio.ratio)) {
        return t`Price below Mark Price`;
      }

      return;
    }

    const positionOrder = p.order as PositionOrderInfo;

    if (!markPrice) {
      return t`Loading...`;
    }

    if (!sizeDeltaUsd?.gt(0)) {
      return t`Enter an amount`;
    }

    if (!triggerPrice?.gt(0)) {
      return t`Enter a price`;
    }

    if (sizeDeltaUsd?.eq(positionOrder.sizeDeltaUsd) && triggerPrice?.eq(positionOrder.triggerPrice!)) {
      return t`Enter new amount or price`;
    }

    if (isLimitOrderType(p.order.orderType)) {
      if (p.order.isLong) {
        if (triggerPrice?.gte(markPrice)) {
          return t`Price above Mark Price`;
        }
      } else {
        if (triggerPrice?.lte(markPrice)) {
          return t`Price below Mark Price`;
        }
      }
    }

    if (isTriggerDecreaseOrderType(p.order.orderType)) {
      if (!markPrice) {
        return t`Loading...`;
      }

      if (sizeDeltaUsd?.eq(p.order.sizeDeltaUsd || 0) && triggerPrice?.eq(positionOrder.triggerPrice || 0)) {
        return t`Enter a new size or price`;
      }

      if (existingPosition?.liquidationPrice) {
        if (existingPosition.isLong && triggerPrice?.lte(existingPosition?.liquidationPrice)) {
          return t`Price below Liq. Price`;
        }

        if (!existingPosition.isLong && triggerPrice?.gte(existingPosition?.liquidationPrice)) {
          return t`Price above Liq. Price`;
        }
      }

      if (p.order.isLong) {
        if (p.order.orderType === OrderType.LimitDecrease && triggerPrice?.lte(markPrice)) {
          return t`Price below Mark Price`;
        }

        if (p.order.orderType === OrderType.StopLossDecrease && triggerPrice?.gte(markPrice)) {
          return t`Price above Mark Price`;
        }
      } else {
        if (p.order.orderType === OrderType.LimitDecrease && triggerPrice?.gte(markPrice)) {
          return t`Price above Mark Price`;
        }

        if (p.order.orderType === OrderType.StopLossDecrease && triggerPrice?.lte(markPrice)) {
          return t`Price below Mark Price`;
        }
      }
    }

    if (isLimitIncreaseOrder) {
      if (nextPositionValues?.nextLeverage?.gt(MAX_ALLOWED_LEVERAGE)) {
        return t`Max leverage: ${(MAX_ALLOWED_LEVERAGE / BASIS_POINTS_DIVISOR).toFixed(1)}x`;
      }
    }
  }

  function getSubmitButtonState(): { text: string; disabled?: boolean; onClick?: () => void } {
    const error = getError();

    if (error) {
      return {
        text: error,
        disabled: true,
      };
    }

    const orderTypeName =
      p.order.orderType === OrderType.LimitIncrease ? t`Limit` : getTriggerNameByOrderType(p.order.orderType);

    return {
      text: `Update ${orderTypeName} Order`,
      disabled: false,
      onClick: onSubmit,
    };
  }

  function onSubmit() {
    if (!signer) return;
    const positionOrder = p.order as PositionOrderInfo;

    setIsSubmitting(true);

    updateOrderTxn(chainId, signer, subaccount, {
      orderKey: p.order.key,
      sizeDeltaUsd: sizeDeltaUsd || positionOrder.sizeDeltaUsd,
      triggerPrice: triggerPrice || positionOrder.triggerPrice,
      acceptablePrice: acceptablePrice || positionOrder.acceptablePrice,
      minOutputAmount: minOutputAmount || p.order.minOutputAmount,
      executionFee: executionFee?.feeTokenAmount,
      indexToken: indexToken,
      setPendingTxns: p.setPendingTxns,
    })
      .then(() => p.onClose())
      .finally(() => {
        setIsSubmitting(false);
      });
  }

  const submitButtonState = getSubmitButtonState();

  useEffect(
    function initValues() {
      if (isInited) return;

      if (isSwapOrderType(p.order.orderType)) {
        const ratio = (p.order as SwapOrderInfo).triggerRatio;

        if (ratio) {
          setTriggerRatioInputValue(formatAmount(ratio.ratio, USD_DECIMALS, 2));
        }
      } else {
        const positionOrder = p.order as PositionOrderInfo;

        setSizeInputValue(formatAmountFree(positionOrder.sizeDeltaUsd || 0, USD_DECIMALS));
        setTriggerPriceInputValue(formatAmount(positionOrder.triggerPrice || 0, USD_DECIMALS, indexPriceDecimals || 2));
      }

      setIsInited(true);
    },
    [fromToken, indexPriceDecimals, isInited, p.order, sizeInputValue, toToken]
  );

  return (
    <div className="PositionEditor">
      <Modal
        className="PositionSeller-modal"
        isVisible={true}
        setIsVisible={p.onClose}
        label={<Trans>Edit {p.order.title}</Trans>}
        allowContentTouchMove
      >
        {!isSwapOrderType(p.order.orderType) && (
          <>
            <BuyInputSection
              topLeftLabel={isTriggerDecreaseOrderType(p.order.orderType) ? t`Close` : t`Size`}
              inputValue={sizeInputValue}
              onInputValueChange={(e) => setSizeInputValue(e.target.value)}
            >
              USD
            </BuyInputSection>

            <BuyInputSection
              topLeftLabel={t`Price`}
              topRightLabel={t`Mark`}
              topRightValue={formatUsd(markPrice, { displayDecimals: indexPriceDecimals })}
              onClickTopRightLabel={() =>
                setTriggerPriceInputValue(formatAmount(markPrice, USD_DECIMALS, indexPriceDecimals || 2))
              }
              inputValue={triggerPirceInputValue}
              onInputValueChange={(e) => setTriggerPriceInputValue(e.target.value)}
            >
              USD
            </BuyInputSection>
          </>
        )}

        {isSwapOrderType(p.order.orderType) && (
          <>
            {triggerRatio && (
              <BuyInputSection
                topLeftLabel={t`Price`}
                topRightValue={formatAmount(markRatio?.ratio, USD_DECIMALS, 4)}
                onClickTopRightLabel={() => {
                  setTriggerRatioInputValue(formatAmount(markRatio?.ratio, USD_DECIMALS, 10));
                }}
                inputValue={triggerRatioInputValue}
                onInputValueChange={(e) => {
                  setTriggerRatioInputValue(e.target.value);
                }}
              >
                {`${triggerRatio.smallestToken.symbol} per ${triggerRatio.largestToken.symbol}`}
              </BuyInputSection>
            )}
          </>
        )}

        <div className="PositionEditor-info-box">
          {isLimitIncreaseOrder && (
            <>
              <ExchangeInfoRow
                label={t`Leverage`}
                value={
                  <ValueTransition
                    from={formatLeverage(existingPosition?.leverage)}
                    to={formatLeverage(nextPositionValues?.nextLeverage) ?? "-"}
                  />
                }
              />

              <div className="line-divider" />
            </>
          )}
          {!isSwapOrderType(p.order.orderType) && (
            <>
              <ExchangeInfoRow
                label={t`Acceptable Price`}
                value={formatAcceptablePrice(acceptablePrice, { displayDecimals: indexPriceDecimals })}
              />

              {existingPosition && (
                <ExchangeInfoRow
                  label={t`Liq. Price`}
                  value={formatLiquidationPrice(existingPosition.liquidationPrice, {
                    displayDecimals: indexPriceDecimals,
                  })}
                />
              )}
            </>
          )}

          {isSwapOrderType(p.order.orderType) && (
            <>
              <ExchangeInfoRow
                label={t`Min. Receive`}
                value={formatTokenAmount(
                  minOutputAmount,
                  p.order.targetCollateralToken.decimals,
                  p.order.targetCollateralToken.symbol
                )}
              />
            </>
          )}

          {executionFee?.feeTokenAmount.gt(0) && (
            <ExchangeInfoRow label={t`Max Execution Fee`}>
              {formatTokenAmount(
                executionFee?.feeTokenAmount,
                executionFee?.feeToken.decimals,
                executionFee?.feeToken.symbol,
                { displayDecimals: 5 }
              )}
            </ExchangeInfoRow>
          )}
        </div>

        <div className="Exchange-swap-button-container">
          <Button
            className="w-full"
            variant="primary-action"
            onClick={submitButtonState.onClick}
            disabled={submitButtonState.disabled}
          >
            {submitButtonState.text}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
