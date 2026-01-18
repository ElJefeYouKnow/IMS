module.exports = function canUseInsights(caps) {
  return !!caps?.ims_enabled && !!caps?.insights_enabled;
};
