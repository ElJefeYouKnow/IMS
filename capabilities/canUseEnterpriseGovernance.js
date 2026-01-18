module.exports = function canUseEnterpriseGovernance(caps) {
  return !!caps?.enterprise_governance;
};
